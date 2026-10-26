import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	createBackup: vi.fn(),
	findBackupById: vi.fn(),
	updateBackupById: vi.fn(),
	findPostgresById: vi.fn(),
	restorePostgresBackup: vi.fn(),
	restoreWebServerBackup: vi.fn(),
	findDestinationRow: vi.fn(),
	findMemberByUserId: vi.fn(),
	removeBackupById: vi.fn(),
	runWebServerBackup: vi.fn(),
	findUser: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: {
			destinations: { findFirst: mocks.findDestinationRow },
			user: { findFirst: mocks.findUser },
		},
	},
}));

vi.mock("@dokploy/server/services/permission", () => ({
	findMemberByUserId: mocks.findMemberByUserId,
	checkPermission: vi.fn(async () => undefined),
	checkServicePermissionAndAccess: vi.fn(async () => undefined),
}));

vi.mock("@dokploy/server", () => ({
	IS_CLOUD: false,
	createBackup: mocks.createBackup,
	findBackupById: mocks.findBackupById,
	updateBackupById: mocks.updateBackupById,
	removeBackupById: mocks.removeBackupById,
	runWebServerBackup: mocks.runWebServerBackup,
	findPostgresById: mocks.findPostgresById,
	scheduleBackup: vi.fn(),
	removeScheduleBackup: vi.fn(),
}));

vi.mock("@dokploy/server/lib/auth", () => ({
	validateRequest: vi.fn(),
}));

vi.mock("@dokploy/server/utils/restore", () => ({
	restorePostgresBackup: mocks.restorePostgresBackup,
	restoreWebServerBackup: mocks.restoreWebServerBackup,
}));

vi.mock("@dokploy/server/utils/backups/compose", () => ({
	runComposeBackup: vi.fn(),
}));

vi.mock("@dokploy/server/utils/backups/utils", () => ({
	getS3Credentials: vi.fn(),
	normalizeS3Path: vi.fn(),
}));

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
}));

vi.mock("@/server/api/utils/audit", () => ({
	audit: vi.fn(async () => undefined),
}));

vi.mock("@/server/api/utils/plan-limits", () => ({
	assertDatabaseBackupLimit: vi.fn(),
}));

vi.mock("@/server/utils/backup", () => ({
	removeJob: vi.fn(),
	schedule: vi.fn(),
	updateJob: vi.fn(),
}));

const { backupRouter } = await import("@/server/api/routers/backup");

const caller = backupRouter.createCaller({
	session: { activeOrganizationId: "org-a" },
	user: { id: "user-1", email: "user@example.com", role: "owner" },
} as Parameters<typeof backupRouter.createCaller>[0]);

const ownDestination = { destinationId: "dest-a", organizationId: "org-a" };
const foreignDestination = { destinationId: "dest-b", organizationId: "org-b" };

const createInput = {
	schedule: "0 0 * * *",
	prefix: "/",
	database: "app",
	databaseType: "postgres" as const,
	postgresId: "pg-1",
	enabled: false,
};

const updateInput = {
	backupId: "backup-1",
	schedule: "0 0 * * *",
	enabled: false,
	prefix: "/",
	database: "app",
	keepLatestCount: 0,
	serviceName: null,
	metadata: {},
	databaseType: "postgres" as const,
};

const restoreInput = {
	databaseId: "pg-1",
	databaseType: "postgres" as const,
	backupType: "database" as const,
	databaseName: "app",
	backupFile: "app/2024.sql.gz",
};

const drain = async (stream: unknown) => {
	for await (const _ of stream as AsyncIterable<string>) {
	}
};

describe("backup endpoints scope destinations to the active organization", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.findMemberByUserId.mockResolvedValue({ role: "owner" });
		mocks.findUser.mockResolvedValue({ role: "owner" });
		mocks.findDestinationRow.mockResolvedValue(ownDestination);
		mocks.createBackup.mockResolvedValue({ backupId: "backup-1" });
		mocks.findBackupById.mockResolvedValue({
			backupId: "backup-1",
			postgresId: "pg-1",
			destinationId: "dest-a",
			enabled: false,
			databaseType: "postgres",
			backupType: "database",
		});
		mocks.findPostgresById.mockResolvedValue({ postgresId: "pg-1" });
	});

	it("rejects creating a backup on a destination from another organization", async () => {
		mocks.findDestinationRow.mockResolvedValue(foreignDestination);

		await expect(
			caller.create({ ...createInput, destinationId: "dest-b" }),
		).rejects.toMatchObject({
			message: "You don't have access to this destination.",
		});
		expect(mocks.createBackup).not.toHaveBeenCalled();
	});

	it("creates a backup on a destination of the active organization", async () => {
		mocks.findDestinationRow.mockResolvedValue(ownDestination);

		await caller.create({ ...createInput, destinationId: "dest-a" });

		expect(mocks.createBackup).toHaveBeenCalledTimes(1);
	});

	it("rejects moving a backup to a destination from another organization", async () => {
		mocks.findDestinationRow.mockResolvedValue(foreignDestination);

		await expect(
			caller.update({ ...updateInput, destinationId: "dest-b" }),
		).rejects.toMatchObject({
			message: "You don't have access to this destination.",
		});
		expect(mocks.updateBackupById).not.toHaveBeenCalled();
	});

	it("rejects restoring from a destination of another organization", async () => {
		mocks.findDestinationRow.mockResolvedValue(foreignDestination);

		const stream = await caller.restoreBackupWithLogs({
			...restoreInput,
			destinationId: "dest-b",
		});
		await expect(drain(stream)).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
		expect(mocks.restorePostgresBackup).not.toHaveBeenCalled();
	});

	it("restores from a destination of the active organization", async () => {
		mocks.findDestinationRow.mockResolvedValue(ownDestination);

		const stream = await caller.restoreBackupWithLogs({
			...restoreInput,
			destinationId: "dest-a",
		});
		await drain(stream);

		expect(mocks.restorePostgresBackup).toHaveBeenCalledTimes(1);
	});

	it("rejects service-less web-server schedules with foreign destinations", async () => {
		mocks.findDestinationRow.mockResolvedValue(foreignDestination);

		await expect(
			caller.create({
				...createInput,
				postgresId: undefined,
				databaseType: "web-server",
				destinationId: "dest-b",
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });

		expect(mocks.createBackup).not.toHaveBeenCalled();
	});

	it("denies ordinary members all service-less backup operations", async () => {
		mocks.findMemberByUserId.mockResolvedValue({ role: "member" });
		mocks.findBackupById.mockResolvedValue({
			backupId: "backup-1",
			databaseType: "web-server",
			destinationId: "dest-a",
		});
		await expect(
			caller.create({
				...createInput,
				postgresId: undefined,
				databaseType: "web-server",
				destinationId: "dest-a",
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		await expect(caller.one({ backupId: "backup-1" })).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
		await expect(caller.remove({ backupId: "backup-1" })).rejects.toMatchObject(
			{ code: "UNAUTHORIZED" },
		);
		await expect(
			caller.update({
				...updateInput,
				databaseType: "web-server",
				destinationId: "dest-a",
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		await expect(
			caller.manualBackupWebServer({ backupId: "backup-1" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(mocks.createBackup).not.toHaveBeenCalled();
		expect(mocks.removeBackupById).not.toHaveBeenCalled();
		expect(mocks.updateBackupById).not.toHaveBeenCalled();
		expect(mocks.runWebServerBackup).not.toHaveBeenCalled();
	});

	it("denies whole-panel restore even to an owner", async () => {
		const stream = await caller.restoreBackupWithLogs({
			...restoreInput,
			databaseType: "web-server",
			databaseId: "",
			destinationId: "dest-a",
		});
		await expect(drain(stream)).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.restoreWebServerBackup).not.toHaveBeenCalled();
	});

	it("denies a panel admin exporting shared control-plane data", async () => {
		mocks.findMemberByUserId.mockResolvedValue({ role: "admin" });
		mocks.findUser.mockResolvedValue({ role: "admin" });
		const admin = backupRouter.createCaller({
			session: { activeOrganizationId: "org-a" },
			user: { id: "admin-1", email: "admin@example.com", role: "admin" },
		} as Parameters<typeof backupRouter.createCaller>[0]);
		await expect(
			admin.create({
				...createInput,
				postgresId: undefined,
				databaseType: "web-server",
				destinationId: "dest-a",
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(mocks.createBackup).not.toHaveBeenCalled();
	});

	it("allows the panel owner to configure a control-plane backup to its own destination", async () => {
		await caller.create({
			...createInput,
			postgresId: undefined,
			databaseType: "web-server",
			destinationId: "dest-a",
		});
		expect(mocks.createBackup).toHaveBeenCalledTimes(1);
	});
});
