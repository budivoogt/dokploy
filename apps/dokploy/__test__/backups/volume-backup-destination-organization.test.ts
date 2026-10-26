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
	findMounts: vi.fn(),
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
vi.mock("@dokploy/server/services/mount", () => ({
	findMountsByApplicationId: mocks.findMounts,
}));
vi.mock("@dokploy/server/utils/backups/utils", () => ({
	getS3Credentials: vi.fn(() => []),
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

const ownDestination = {
	destinationId: "dest-a",
	organizationId: "org-a",
	bucket: "backups",
};
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
		mocks.findMounts.mockResolvedValue([
			{
				type: "volume",
				serviceType: "application",
				applicationId: "app-1",
				volumeName: "app_data",
			},
		]);
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

	it("generates an own-volume restore after all containers and the volume have been removed", async () => {
		mocks.execAsync.mockResolvedValue({ stdout: "", stderr: "" });
		const command = await restoreVolume(
			"app-1",
			"dest-a",
			"app_data",
			"data.tar",
			"",
			"application",
		);
		expect(command).toContain("-v app_data:/volume_data");
		expect(command).toContain('docker ps -a --filter "volume=app_data"');
		expect(command).toContain("Volume restore aborted - volume is in use");
		expect(mocks.execAsync).not.toHaveBeenCalled();
	});

	it("refuses a foreign volume after teardown", async () => {
		mocks.execAsync.mockResolvedValue({ stdout: "", stderr: "" });
		await expect(
			restoreVolume(
				"app-1",
				"dest-a",
				"foreign_data",
				"data.tar",
				"",
				"application",
			),
		).rejects.toThrow("does not belong");
		expect(mocks.execAsync).not.toHaveBeenCalled();
	});

	it.each([
		{ applicationId: "foreign-app" },
		{ applicationId: "app-1", composeId: "compose-2" },
	])(
		"refuses foreign or ambiguous persisted mount ownership",
		async (target) => {
			mocks.findMounts.mockResolvedValue([
				{
					type: "volume",
					serviceType: "application",
					volumeName: "app_data",
					...target,
				},
			]);
			await expect(
				restoreVolume(
					"app-1",
					"dest-a",
					"app_data",
					"data.tar",
					"",
					"application",
				),
			).rejects.toThrow("does not belong");
			expect(mocks.execAsync).not.toHaveBeenCalled();
		},
	);

	it.each([
		{ definition: "{}", name: "app_data" },
		{ definition: "{name: durable_data}", name: "durable_data" },
		{ definition: "{external: true}", name: "data" },
	])(
		"restores a persisted raw Compose volume after teardown: $name",
		async ({ definition, name }) => {
			mocks.findMounts.mockResolvedValue([]);
			mocks.loadService.mockResolvedValue({
				appName: "app",
				serverId: null,
				sourceType: "raw",
				composeFile: `services:\n  database:\n    image: postgres\n    volumes: [data:/var/lib/data]\nvolumes:\n  data: ${definition}\n`,
			});
			const command = await restoreVolume(
				"compose-1",
				"dest-a",
				name,
				"data.tar",
				"",
				"compose",
			);
			expect(command).toContain(`-v ${name}:/volume_data`);
			expect(mocks.execAsync).not.toHaveBeenCalled();
			await expect(
				restoreVolume(
					"compose-1",
					"dest-a",
					"foreign_data",
					"data.tar",
					"",
					"compose",
				),
			).rejects.toThrow("does not belong");
		},
	);

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
		await expect(
			caller.restoreVolumeBackupWithLogs({
				id: "foreign-app",
				serviceType: "application",
				volumeName: "app_data",
				destinationId: "dest-a",
				backupFileName: "data.tar",
			}),
		).rejects.toThrow("Foreign service denied");
		expect(mocks.execAsync).not.toHaveBeenCalled();
	});
});
