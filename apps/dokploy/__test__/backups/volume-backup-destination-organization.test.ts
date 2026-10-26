import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	createVolumeBackup: vi.fn(),
	findVolumeBackupById: vi.fn(),
	updateVolumeBackup: vi.fn(),
	findDestinationRow: vi.fn(),
	serviceAccess: vi.fn(),
	loadService: vi.fn(),
	execAsync: vi.fn(),
	runVolumeBackup: vi.fn(),
	removeVolumeBackup: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => ({
	db: { query: { destinations: { findFirst: mocks.findDestinationRow } } },
}));

vi.mock("@dokploy/server/services/permission", () => ({
	checkPermission: vi.fn(async () => undefined),
	checkServicePermissionAndAccess: mocks.serviceAccess,
}));

vi.mock("@dokploy/server", () => ({
	IS_CLOUD: false,
	createVolumeBackup: mocks.createVolumeBackup,
	findVolumeBackupById: mocks.findVolumeBackupById,
	updateVolumeBackup: mocks.updateVolumeBackup,
	scheduleVolumeBackup: vi.fn(),
	removeVolumeBackupJob: vi.fn(),
	removeVolumeBackup: mocks.removeVolumeBackup,
	restoreVolume: vi.fn(),
	runVolumeBackup: mocks.runVolumeBackup,
}));

vi.mock("@dokploy/server/lib/auth", () => ({
	validateRequest: vi.fn(),
}));

vi.mock("@dokploy/server/services/server", () => ({
	findServerById: vi.fn(),
}));

vi.mock("@dokploy/server/services/application", () => ({
	findApplicationById: mocks.loadService,
}));
vi.mock("@dokploy/server/services/compose", () => ({
	findComposeById: mocks.loadService,
}));
vi.mock("@dokploy/server/services/postgres", () => ({
	findPostgresById: mocks.loadService,
}));
vi.mock("@dokploy/server/services/mysql", () => ({
	findMySqlById: mocks.loadService,
}));
vi.mock("@dokploy/server/services/mariadb", () => ({
	findMariadbById: mocks.loadService,
}));
vi.mock("@dokploy/server/services/mongo", () => ({
	findMongoById: mocks.loadService,
}));
vi.mock("@dokploy/server/services/redis", () => ({
	findRedisById: mocks.loadService,
}));
vi.mock("@dokploy/server/services/libsql", () => ({
	findLibsqlById: mocks.loadService,
}));

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: mocks.execAsync,
	execAsyncRemote: vi.fn(),
	execAsyncStream: vi.fn(),
}));

vi.mock("@/server/api/utils/audit", () => ({
	audit: vi.fn(async () => undefined),
}));

vi.mock("@/server/api/utils/plan-limits", () => ({
	assertVolumeBackupLimit: vi.fn(),
}));

vi.mock("@/server/utils/backup", () => ({
	removeJob: vi.fn(),
	schedule: vi.fn(),
	updateJob: vi.fn(),
}));

const { volumeBackupsRouter } = await import(
	"@/server/api/routers/volume-backups"
);
const { backupVolume } = await import(
	"@dokploy/server/utils/volume-backups/backup"
);
const { restoreVolume } = await import(
	"@dokploy/server/utils/volume-backups/restore"
);

const caller = volumeBackupsRouter.createCaller({
	session: { activeOrganizationId: "org-a" },
	user: { id: "user-1", email: "user@example.com", role: "owner" },
} as Parameters<typeof volumeBackupsRouter.createCaller>[0]);

const ownDestination = { destinationId: "dest-a", organizationId: "org-a" };
const foreignDestination = { destinationId: "dest-b", organizationId: "org-b" };

const createInput = {
	name: "data",
	volumeName: "app_data",
	prefix: "/",
	cronExpression: "0 0 * * *",
	serviceType: "application" as const,
	applicationId: "app-1",
	enabled: false,
};

describe("volume backup endpoints scope destinations to the active organization", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.serviceAccess.mockResolvedValue(undefined);
		mocks.findDestinationRow.mockResolvedValue(ownDestination);
		mocks.loadService.mockResolvedValue({ appName: "app", serverId: null });
		mocks.execAsync.mockImplementation(async (command: string) => ({
			stdout: command.includes("inspect")
				? '[{"Type":"volume","Name":"app_data"}]'
				: "aabbccddeeff",
			stderr: "",
		}));
		mocks.createVolumeBackup.mockResolvedValue({
			volumeBackupId: "vb-1",
			enabled: false,
		});
		mocks.findVolumeBackupById.mockResolvedValue({
			...createInput,
			volumeBackupId: "vb-1",
			applicationId: "app-1",
			destinationId: "dest-a",
		});
		mocks.updateVolumeBackup.mockResolvedValue({
			volumeBackupId: "vb-1",
			enabled: false,
		});
	});

	it("rejects creating a volume backup on a destination from another organization", async () => {
		mocks.findDestinationRow.mockResolvedValue(foreignDestination);

		await expect(
			caller.create({ ...createInput, destinationId: "dest-b" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(mocks.createVolumeBackup).not.toHaveBeenCalled();
	});

	it("creates a volume backup on a destination of the active organization", async () => {
		mocks.findDestinationRow.mockResolvedValue(ownDestination);

		await caller.create({ ...createInput, destinationId: "dest-a" });

		expect(mocks.createVolumeBackup).toHaveBeenCalledTimes(1);
	});

	it("rejects moving a volume backup to a destination from another organization", async () => {
		mocks.findDestinationRow.mockResolvedValue(foreignDestination);

		await expect(
			caller.update({
				...createInput,
				volumeBackupId: "vb-1",
				destinationId: "dest-b",
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(mocks.updateVolumeBackup).not.toHaveBeenCalled();
	});

	it.each([{ applicationId: undefined }, { composeId: "compose-2" }])(
		"rejects missing or ambiguous service ownership before creating a backup",
		async (target) => {
			await expect(
				caller.create({ ...createInput, destinationId: "dest-a", ...target }),
			).rejects.toThrow("exactly one");
			expect(mocks.createVolumeBackup).not.toHaveBeenCalled();
			expect(mocks.execAsync).not.toHaveBeenCalled();
		},
	);

	it("rejects another service's volume on create and update", async () => {
		mocks.execAsync.mockImplementation(async (command: string) => ({
			stdout: command.includes("inspect")
				? '[{"Type":"volume","Name":"foreign_data"}]'
				: "aabbccddeeff",
			stderr: "",
		}));
		await expect(
			caller.create({ ...createInput, destinationId: "dest-a" }),
		).rejects.toThrow("does not belong");
		await expect(
			caller.update({
				...createInput,
				destinationId: "dest-a",
				volumeBackupId: "vb-1",
			}),
		).rejects.toThrow("does not belong");
		expect(mocks.createVolumeBackup).not.toHaveBeenCalled();
		expect(mocks.updateVolumeBackup).not.toHaveBeenCalled();
	});

	it("rejects stored foreign-volume definitions at backup execution time", async () => {
		mocks.execAsync.mockImplementation(async (command: string) => ({
			stdout: command.includes("inspect")
				? '[{"Type":"volume","Name":"foreign_data"}]'
				: "aabbccddeeff",
			stderr: "",
		}));
		await expect(
			backupVolume({ ...createInput, destinationId: "dest-a" } as never),
		).rejects.toThrow("does not belong");
	});

	it("rejects a mismatched server before generating a restore command", async () => {
		await expect(
			restoreVolume(
				"app-1",
				"dest-a",
				"app_data",
				"data.tar",
				"server-b",
				"application",
			),
		).rejects.toThrow("does not match");
	});

	it("checks access to stored definitions before read, delete, update and execution", async () => {
		mocks.serviceAccess.mockRejectedValue(new Error("Foreign service denied"));
		await expect(caller.one({ volumeBackupId: "vb-1" })).rejects.toThrow(
			"Foreign service denied",
		);
		await expect(caller.delete({ volumeBackupId: "vb-1" })).rejects.toThrow(
			"Foreign service denied",
		);
		await expect(
			caller.update({
				...createInput,
				destinationId: "dest-a",
				volumeBackupId: "vb-1",
			}),
		).rejects.toThrow("Foreign service denied");
		await expect(
			caller.runManually({ volumeBackupId: "vb-1" }),
		).rejects.toThrow("Foreign service denied");
		expect(mocks.removeVolumeBackup).not.toHaveBeenCalled();
		expect(mocks.updateVolumeBackup).not.toHaveBeenCalled();
		expect(mocks.runVolumeBackup).not.toHaveBeenCalled();
	});

	it("checks the restore service before executing a command", async () => {
		mocks.serviceAccess.mockRejectedValue(new Error("Foreign service denied"));
		const stream = await caller.restoreVolumeBackupWithLogs({
			id: "foreign-app",
			serviceType: "application",
			volumeName: "app_data",
			destinationId: "dest-a",
			backupFileName: "data.tar",
		});
		await expect(
			(async () => {
				for await (const _ of stream as AsyncIterable<string>) {
				}
			})(),
		).rejects.toThrow("Foreign service denied");
		expect(mocks.execAsync).not.toHaveBeenCalled();
	});
});
