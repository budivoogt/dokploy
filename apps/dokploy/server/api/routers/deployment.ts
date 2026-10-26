import {
	execAsync,
	execAsyncRemote,
	findAllDeploymentsByApplicationId,
	findAllDeploymentsByComposeId,
	findAllDeploymentsByServerId,
	findAllDeploymentsCentralized,
	findBackupById,
	findDeploymentById,
	findPreviewDeploymentById,
	findScheduleById,
	findVolumeBackupById,
	IS_CLOUD,
	removeDeployment,
	resolveServicePath,
	updateDeploymentStatus,
} from "@dokploy/server";
import { db } from "@dokploy/server/db";
import { findDestinationByIdForOrganization } from "@dokploy/server/services/destination";
import type { PermissionCtx } from "@dokploy/server/services/permission";
import {
	checkPermission,
	checkServicePermissionAndAccess,
	findMemberByUserId,
} from "@dokploy/server/services/permission";
import { findServerById } from "@dokploy/server/services/server";
import { TRPCError } from "@trpc/server";
import { desc, eq } from "drizzle-orm";
import { quote } from "shell-quote";
import { z } from "zod";
import { audit } from "@/server/api/utils/audit";
import {
	assertServerOrganization,
	requireOrganizationAdmin,
	requirePanelOwner,
} from "@/server/api/utils/resource-access";
import {
	apiFindAllByApplication,
	apiFindAllByCompose,
	apiFindAllByServer,
	apiFindAllByType,
	deployments,
	server,
} from "@/server/db/schema";
import { myQueue } from "@/server/queues/queueSetup";
import { fetchDeployApiJobs, type QueueJobRow } from "@/server/utils/deploy";
import { createTRPCRouter, protectedProcedure, withPermission } from "../trpc";

type DeploymentTarget = Partial<
	Pick<
		Awaited<ReturnType<typeof findDeploymentById>>,
		| "applicationId"
		| "composeId"
		| "scheduleId"
		| "backupId"
		| "volumeBackupId"
		| "previewDeploymentId"
		| "serverId"
		| "buildServerId"
		| "application"
		| "compose"
	>
>;

const checkDeploymentAccess = async (
	ctx: PermissionCtx,
	target: DeploymentTarget,
	action: "read" | "cancel",
) => {
	let serviceId = target.applicationId || target.composeId;
	let serverId =
		target.serverId || target.application?.serverId || target.compose?.serverId;
	let localOrganizationId: string | null | undefined;
	if (target.scheduleId) {
		const schedule = await findScheduleById(target.scheduleId);
		if (schedule.organizationId !== ctx.session.activeOrganizationId) {
			throw new TRPCError({ code: "UNAUTHORIZED" });
		}
		serviceId = schedule.applicationId || schedule.composeId;
		serverId = schedule.serverId;
		localOrganizationId = schedule.organizationId;
	} else if (target.backupId) {
		const backup = await findBackupById(target.backupId);
		const ids = [
			backup.postgresId,
			backup.mysqlId,
			backup.mariadbId,
			backup.mongoId,
			backup.libsqlId,
			backup.composeId,
		].filter(Boolean);
		if (
			ids.length > 1 ||
			(backup.databaseType === "web-server" && ids.length > 0)
		)
			throw new TRPCError({ code: "UNAUTHORIZED" });
		serviceId = ids[0];
		if (!serviceId) {
			await requireOrganizationAdmin(ctx);
			await findDestinationByIdForOrganization(
				backup.destinationId,
				ctx.session.activeOrganizationId,
			);
			localOrganizationId = ctx.session.activeOrganizationId;
		}
	} else if (target.volumeBackupId) {
		const backup = await findVolumeBackupById(target.volumeBackupId);
		const ids = [
			backup.applicationId,
			backup.composeId,
			backup.postgresId,
			backup.mysqlId,
			backup.mariadbId,
			backup.mongoId,
			backup.redisId,
			backup.libsqlId,
		].filter(Boolean);
		if (ids.length !== 1) throw new TRPCError({ code: "UNAUTHORIZED" });
		serviceId = ids[0];
	} else if (target.previewDeploymentId) {
		const preview = await findPreviewDeploymentById(target.previewDeploymentId);
		serviceId = preview.applicationId;
	}
	if (serviceId) {
		await checkServicePermissionAndAccess(ctx, serviceId, {
			deployment: [action],
		});
	} else {
		await requireOrganizationAdmin(ctx);
		if (!serverId && localOrganizationId !== ctx.session.activeOrganizationId) {
			throw new TRPCError({ code: "UNAUTHORIZED" });
		}
		await checkPermission(ctx, { deployment: [action] });
	}
	await assertServerOrganization(ctx, serverId);
	await assertServerOrganization(ctx, target.serverId);
	await assertServerOrganization(ctx, target.buildServerId);
	return serverId;
};

export const deploymentRouter = createTRPCRouter({
	all: protectedProcedure
		.input(apiFindAllByApplication)
		.query(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.applicationId, {
				deployment: ["read"],
			});
			return await findAllDeploymentsByApplicationId(input.applicationId);
		}),

	allByCompose: protectedProcedure
		.input(apiFindAllByCompose)
		.query(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.composeId, {
				deployment: ["read"],
			});
			return await findAllDeploymentsByComposeId(input.composeId);
		}),
	allByServer: withPermission("deployment", "read")
		.input(apiFindAllByServer)
		.query(async ({ input, ctx }) => {
			await requireOrganizationAdmin(ctx);
			const targetServer = await findServerById(input.serverId);
			if (targetServer.organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You don't have access to this server.",
				});
			}
			return await findAllDeploymentsByServerId(input.serverId);
		}),
	allCentralized: withPermission("deployment", "read").query(
		async ({ ctx }) => {
			const orgId = ctx.session.activeOrganizationId;
			const accessedServices =
				ctx.user.role !== "owner" && ctx.user.role !== "admin"
					? (await findMemberByUserId(ctx.user.id, orgId)).accessedServices
					: null;
			if (accessedServices !== null && accessedServices.length === 0) {
				return [];
			}
			return findAllDeploymentsCentralized(orgId, accessedServices);
		},
	),

	queueList: withPermission("deployment", "read").query(async ({ ctx }) => {
		if (IS_CLOUD) await requireOrganizationAdmin(ctx);
		else await requirePanelOwner(ctx);
		const orgId = ctx.session.activeOrganizationId;
		let rows: QueueJobRow[];

		if (IS_CLOUD) {
			const servers = await db.query.server.findMany({
				where: eq(server.organizationId, orgId),
				columns: { serverId: true },
			});
			const serverRowsArrays = await Promise.all(
				servers.map(({ serverId }) => fetchDeployApiJobs(serverId)),
			);
			rows = serverRowsArrays.flat();
			rows.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
		} else {
			const jobs = await myQueue.getJobs();
			const jobRows = await Promise.all(
				jobs.map(async (job) => {
					const state = await job.getState();
					return {
						id: String(job.id),
						name: job.name ?? undefined,
						data: job.data as Record<string, unknown>,
						timestamp: job.timestamp,
						processedOn: job.processedOn,
						finishedOn: job.finishedOn,
						failedReason: job.failedReason ?? undefined,
						state,
					};
				}),
			);
			jobRows.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
			rows = jobRows;
		}

		return Promise.all(
			rows.map(async (row) => ({
				...row,
				servicePath: await resolveServicePath(
					orgId,
					(row.data ?? {}) as Record<string, unknown>,
				),
			})),
		);
	}),

	allByType: protectedProcedure
		.input(apiFindAllByType)
		.query(async ({ input, ctx }) => {
			await checkDeploymentAccess(
				ctx,
				{ [`${input.type}Id`]: input.id },
				"read",
			);
			const deploymentsList = await db.query.deployments.findMany({
				where: eq(deployments[`${input.type}Id`], input.id),
				orderBy: desc(deployments.createdAt),
				with: {
					rollback: true,
				},
			});
			return deploymentsList;
		}),
	killProcess: protectedProcedure
		.input(
			z.object({
				deploymentId: z.string().min(1),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			const deployment = await findDeploymentById(input.deploymentId);
			const serverId = await checkDeploymentAccess(ctx, deployment, "cancel");

			if (!deployment.pid || !/^[1-9][0-9]*$/.test(deployment.pid)) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Deployment is not running",
				});
			}

			const command = `kill -9 ${deployment.pid}`;
			if (serverId) {
				await execAsyncRemote(serverId, command);
			} else {
				await execAsync(command);
			}

			await updateDeploymentStatus(deployment.deploymentId, "error");
			await audit(ctx, {
				action: "cancel",
				resourceType: "deployment",
				resourceId: deployment.deploymentId,
			});
		}),

	removeDeployment: protectedProcedure
		.input(
			z.object({
				deploymentId: z.string().min(1),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			const deployment = await findDeploymentById(input.deploymentId);
			await checkDeploymentAccess(ctx, deployment, "cancel");
			const result = await removeDeployment(input.deploymentId);
			await audit(ctx, {
				action: "delete",
				resourceType: "deployment",
				resourceId: deployment.deploymentId,
			});
			return result;
		}),

	readLogs: protectedProcedure
		.input(
			z.object({
				deploymentId: z.string().min(1),
				tail: z.number().int().min(1).max(10000).default(100),
			}),
		)
		.query(async ({ input, ctx }) => {
			const deployment = await findDeploymentById(input.deploymentId);
			const serverId = await checkDeploymentAccess(ctx, deployment, "read");

			if (!deployment.logPath) {
				return "";
			}

			const command = `tail -n ${input.tail} ${quote([deployment.logPath])} 2>/dev/null || echo ""`;
			if (serverId) {
				const { stdout } = await execAsyncRemote(serverId, command);
				return stdout;
			}

			if (IS_CLOUD) {
				return "";
			}

			const { stdout } = await execAsync(command);
			return stdout;
		}),
});
