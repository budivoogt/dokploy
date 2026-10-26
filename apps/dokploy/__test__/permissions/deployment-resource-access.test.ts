import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findDeploymentById: vi.fn(),
	findBackupById: vi.fn(),
	findVolumeBackupById: vi.fn(),
	findPreviewDeploymentById: vi.fn(),
	findScheduleById: vi.fn(),
	findServerById: vi.fn(),
	findMemberByUserId: vi.fn(),
	checkService: vi.fn(),
	checkPermission: vi.fn(),
	destination: vi.fn(),
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
	removeDeployment: vi.fn(),
	updateDeploymentStatus: vi.fn(),
	list: vi.fn(),
	queue: vi.fn(),
}));
vi.mock("@dokploy/server", () => ({
	...mocks,
	IS_CLOUD: false,
	findAllDeploymentsByApplicationId: vi.fn(),
	findAllDeploymentsByComposeId: vi.fn(),
	findAllDeploymentsByServerId: mocks.list,
	findAllDeploymentsCentralized: vi.fn(),
	resolveServicePath: vi.fn(),
}));
vi.mock("@dokploy/server/db", () => ({
	db: { query: { deployments: { findMany: mocks.list } } },
}));
vi.mock("@dokploy/server/services/permission", () => ({
	checkPermission: mocks.checkPermission,
	checkServicePermissionAndAccess: mocks.checkService,
	findMemberByUserId: mocks.findMemberByUserId,
}));
vi.mock("@dokploy/server/services/server", () => ({
	findServerById: mocks.findServerById,
}));
vi.mock("@dokploy/server/services/destination", () => ({
	findDestinationByIdForOrganization: mocks.destination,
}));
vi.mock("@dokploy/server/lib/auth", () => ({ validateRequest: vi.fn() }));
vi.mock("@/server/api/utils/audit", () => ({ audit: vi.fn() }));
vi.mock("@/server/queues/queueSetup", () => ({
	myQueue: { getJobs: mocks.queue },
}));
vi.mock("@/server/utils/deploy", () => ({ fetchDeployApiJobs: vi.fn() }));

const { deploymentRouter } = await import("@/server/api/routers/deployment");
const caller = deploymentRouter.createCaller({
	session: { activeOrganizationId: "org-a" },
	user: { id: "user-a", email: "user@example.com", role: "owner" },
} as Parameters<typeof deploymentRouter.createCaller>[0]);
const drainDeniedEffects = () => {
	expect(mocks.execAsync).not.toHaveBeenCalled();
	expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
	expect(mocks.removeDeployment).not.toHaveBeenCalled();
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.findMemberByUserId.mockResolvedValue({ role: "owner" });
	mocks.findServerById.mockImplementation(async (id: string) => ({
		organizationId: id === "server-a" ? "org-a" : "org-b",
	}));
	mocks.checkPermission.mockResolvedValue(undefined);
	mocks.checkService.mockImplementation(async (_ctx, id: string) => {
		if (id.endsWith("-b")) throw new Error("Foreign service denied");
	});
	mocks.findBackupById.mockResolvedValue({
		postgresId: "postgres-b",
		destinationId: "destination-b",
	});
	mocks.findVolumeBackupById.mockResolvedValue({ applicationId: "app-b" });
	mocks.findPreviewDeploymentById.mockResolvedValue({ applicationId: "app-b" });
	mocks.findScheduleById.mockResolvedValue({
		organizationId: "org-b",
		serverId: null,
	});
	mocks.execAsync.mockResolvedValue({ stdout: "own log" });
});

describe("deployment resource ownership", () => {
	it.each([
		{ backupId: "backup-b" },
		{ volumeBackupId: "volume-b" },
		{ previewDeploymentId: "preview-b" },
		{ scheduleId: "local-schedule-b" },
		{ serverId: "server-b" },
		{},
	])(
		"denies log reads and mutations for foreign or unresolvable records: %j",
		async (target) => {
			mocks.findDeploymentById.mockResolvedValue({
				...target,
				deploymentId: "deployment-1",
				logPath: "/tmp/private",
				pid: "123",
			});
			await expect(
				caller.readLogs({ deploymentId: "deployment-1" }),
			).rejects.toThrow();
			await expect(
				caller.killProcess({ deploymentId: "deployment-1" }),
			).rejects.toThrow();
			await expect(
				caller.removeDeployment({ deploymentId: "deployment-1" }),
			).rejects.toThrow();
			drainDeniedEffects();
		},
	);

	it("denies foreign resource lists through allByType", async () => {
		await expect(
			caller.allByType({ type: "backup", id: "backup-b" }),
		).rejects.toThrow();
		await expect(
			caller.allByType({ type: "schedule", id: "schedule-b" }),
		).rejects.toThrow();
		await expect(
			caller.allByType({ type: "server", id: "server-b" }),
		).rejects.toThrow();
		expect(mocks.list).not.toHaveBeenCalled();
	});

	it("denies ordinary members global server lists and queue contents", async () => {
		mocks.findMemberByUserId.mockResolvedValue({ role: "member" });
		await expect(
			caller.allByServer({ serverId: "server-a" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		await expect(caller.queueList()).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
		expect(mocks.list).not.toHaveBeenCalled();
		expect(mocks.queue).not.toHaveBeenCalled();
	});

	it("requires cancel permission for a schedule action", async () => {
		mocks.findDeploymentById.mockResolvedValue({
			scheduleId: "schedule-a",
			deploymentId: "deployment-1",
			pid: "123",
		});
		mocks.findScheduleById.mockResolvedValue({
			organizationId: "org-a",
			applicationId: "app-a",
		});
		mocks.checkService.mockImplementation(async (_ctx, _id, permission) => {
			if (permission.deployment.includes("cancel"))
				throw new Error("Cancel denied");
		});
		await expect(
			caller.killProcess({ deploymentId: "deployment-1" }),
		).rejects.toThrow("Cancel denied");
		drainDeniedEffects();
	});

	it("denies a panel admin the shared self-hosted raw queue", async () => {
		mocks.findMemberByUserId.mockResolvedValue({ role: "admin" });
		const admin = deploymentRouter.createCaller({
			session: { activeOrganizationId: "org-a" },
			user: { id: "admin-1", email: "admin@example.com", role: "admin" },
		} as Parameters<typeof deploymentRouter.createCaller>[0]);
		await expect(admin.queueList()).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
		expect(mocks.queue).not.toHaveBeenCalled();
	});

	it("allows the panel owner to inspect the shared queue", async () => {
		mocks.queue.mockResolvedValue([]);
		expect(await caller.queueList()).toEqual([]);
		expect(mocks.queue).toHaveBeenCalledTimes(1);
	});

	it("permits a service backup log through its owning service", async () => {
		mocks.findDeploymentById.mockResolvedValue({
			backupId: "backup-a",
			logPath: "/tmp/own",
		});
		mocks.findBackupById.mockResolvedValue({ postgresId: "postgres-a" });
		expect(await caller.readLogs({ deploymentId: "deployment-1" })).toBe(
			"own log",
		);
		expect(mocks.checkService).toHaveBeenCalledWith(
			expect.anything(),
			"postgres-a",
			{ deployment: ["read"] },
		);
	});
});
