import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const traefikPath = vi.hoisted(() => `${process.cwd()}/.docker/traefik`);

const mocks = vi.hoisted(() => ({
	findServerById: vi.fn(),
	readDirectory: vi.fn(),
	readConfigInPath: vi.fn(),
	writeTraefikConfigInPath: vi.fn(),
	updateServerById: vi.fn(),
	reloadDockerResource: vi.fn(),
}));

vi.mock("@dokploy/server/services/permission", () => ({
	checkPermission: vi.fn(async () => undefined),
}));

vi.mock("@dokploy/server", () => ({
	IS_CLOUD: false,
	paths: () => ({ MAIN_TRAEFIK_PATH: traefikPath }),
	...mocks,
}));

vi.mock("@dokploy/server/lib/auth", () => ({
	validateRequest: vi.fn(),
}));
vi.mock("@dokploy/server/services/server", () => ({
	findServerById: mocks.findServerById,
}));

vi.mock("@/server/api/utils/audit", () => ({
	audit: vi.fn(async () => undefined),
}));

vi.mock("@/server/queues/queueSetup", () => ({
	cleanAllDeploymentQueue: vi.fn(),
}));

vi.mock("@/server/utils/backup", () => ({
	removeJob: vi.fn(),
	schedule: vi.fn(),
}));

const { settingsRouter } = await import("@/server/api/routers/settings");

const caller = settingsRouter.createCaller({
	session: { activeOrganizationId: "org-a" },
	user: { id: "user-1", email: "user@example.com", role: "member" },
} as Parameters<typeof settingsRouter.createCaller>[0]);

const filePath = path.join(traefikPath, "dynamic/app.yml");
const admin = settingsRouter.createCaller({
	session: { activeOrganizationId: "org-a" },
	user: { id: "user-1", email: "user@example.com", role: "owner" },
} as Parameters<typeof settingsRouter.createCaller>[0]);

describe("traefik file endpoints scope remote servers to the active organization", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.findServerById.mockImplementation(async (serverId: string) => ({
			serverId,
			organizationId: serverId === "server-a" ? "org-a" : "org-b",
		}));
		mocks.readDirectory.mockResolvedValue([]);
		mocks.readConfigInPath.mockResolvedValue("http: {}");
	});

	it("denies foreign-server cleanup updates and admin actions before effects", async () => {
		await expect(
			admin.updateDockerCleanup({
				serverId: "server-b",
				enableDockerCleanup: true,
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		await expect(
			admin.reloadTraefik({ serverId: "server-b" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(mocks.updateServerById).not.toHaveBeenCalled();
		expect(mocks.reloadDockerResource).not.toHaveBeenCalled();
	});

	it("rejects listing a server from another organization", async () => {
		await expect(
			caller.readDirectories({ serverId: "server-b" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(mocks.readDirectory).not.toHaveBeenCalled();
	});

	it("rejects writing to a server from another organization", async () => {
		await expect(
			caller.updateTraefikFile({
				path: filePath,
				traefikConfig: "http: {}",
				serverId: "server-b",
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(mocks.writeTraefikConfigInPath).not.toHaveBeenCalled();
	});

	it("rejects reading from a server from another organization", async () => {
		await expect(
			caller.readTraefikFile({ path: filePath, serverId: "server-b" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(mocks.readConfigInPath).not.toHaveBeenCalled();
	});

	it("allows servers of the active organization", async () => {
		await caller.readDirectories({ serverId: "server-a" });
		await caller.readTraefikFile({ path: filePath, serverId: "server-a" });
		await caller.updateTraefikFile({
			path: filePath,
			traefikConfig: "http: {}",
			serverId: "server-a",
		});

		expect(mocks.readDirectory).toHaveBeenCalledWith(traefikPath, "server-a");
		expect(mocks.readConfigInPath).toHaveBeenCalledWith(filePath, "server-a");
		expect(mocks.writeTraefikConfigInPath).toHaveBeenCalledWith(
			filePath,
			"http: {}",
			"server-a",
		);
	});

	it("does not look up a server when none is given", async () => {
		await caller.readDirectories({});
		await caller.updateTraefikFile({
			path: filePath,
			traefikConfig: "http: {}",
		});

		expect(mocks.findServerById).not.toHaveBeenCalled();
		expect(mocks.writeTraefikConfigInPath).toHaveBeenCalledWith(
			filePath,
			"http: {}",
			undefined,
		);
	});

	it.each([
		"../outside.yml",
		"/tmp/outside.yml",
		`${traefikPath}-sibling/app.yml`,
	])("rejects writes outside the Traefik directory: %s", async (unsafePath) => {
		await expect(
			caller.updateTraefikFile({ path: unsafePath, traefikConfig: "http: {}" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.writeTraefikConfigInPath).not.toHaveBeenCalled();
	});

	it("rejects remote writes that escape the Traefik directory", async () => {
		await expect(
			caller.updateTraefikFile({
				path: "../outside.yml",
				traefikConfig: "http: {}",
				serverId: "server-a",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.writeTraefikConfigInPath).not.toHaveBeenCalled();
	});
});
