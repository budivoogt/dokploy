import {
	createVolumeBackup,
	findVolumeBackupById,
	IS_CLOUD,
	removeVolumeBackup,
	removeVolumeBackupJob,
	restoreVolume,
	runVolumeBackup,
	scheduleVolumeBackup,
	updateVolumeBackup,
} from "@dokploy/server";
import { db } from "@dokploy/server/db";
import {
	createVolumeBackupSchema,
	updateVolumeBackupSchema,
	VOLUME_NAME_MESSAGE,
	VOLUME_NAME_REGEX,
	volumeBackups,
} from "@dokploy/server/db/schema";
import {
	findDestinationById,
	findDestinationByIdForOrganization,
} from "@dokploy/server/services/destination";
import type { PermissionCtx } from "@dokploy/server/services/permission";
import { checkServicePermissionAndAccess } from "@dokploy/server/services/permission";
import { findServerById } from "@dokploy/server/services/server";
import {
	execAsyncRemote,
	execAsyncStream,
} from "@dokploy/server/utils/process/execAsync";
import {
	assertDeclaredServiceVolume,
	assertServiceVolume,
	volumeBackupService,
} from "@dokploy/server/utils/volume-backups/access";
import { TRPCError } from "@trpc/server";
import { observable } from "@trpc/server/observable";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { audit } from "@/server/api/utils/audit";
import { assertVolumeBackupLimit } from "@/server/api/utils/plan-limits";
import { removeJob, schedule, updateJob } from "@/server/utils/backup";
import { createTRPCRouter, protectedProcedure, withPermission } from "../trpc";

const checkVolumeBackupAccess = async (
	ctx: PermissionCtx,
	target: Parameters<typeof volumeBackupService>[0] & { destinationId: string },
	action: "read" | "create" | "update" | "delete",
) => {
	const service = volumeBackupService(target);
	await checkServicePermissionAndAccess(ctx, service.id, {
		volumeBackup: [action],
	});
	await findDestinationByIdForOrganization(
		target.destinationId,
		ctx.session.activeOrganizationId,
	);
	return service;
};

export const volumeBackupsRouter = createTRPCRouter({
	list: protectedProcedure
		.input(
			z.object({
				id: z.string().min(1),
				volumeBackupType: z.enum([
					"application",
					"postgres",
					"mysql",
					"mariadb",
					"mongo",
					"redis",
					"compose",
					"libsql",
				]),
			}),
		)
		.query(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.id, {
				volumeBackup: ["read"],
			});
			return await db.query.volumeBackups.findMany({
				where: eq(volumeBackups[`${input.volumeBackupType}Id`], input.id),
				with: {
					application: {
						columns: { applicationId: true, appName: true, serverId: true },
					},
					postgres: {
						columns: { postgresId: true, appName: true, serverId: true },
					},
					mysql: { columns: { mysqlId: true, appName: true, serverId: true } },
					mariadb: {
						columns: { mariadbId: true, appName: true, serverId: true },
					},
					mongo: { columns: { mongoId: true, appName: true, serverId: true } },
					redis: { columns: { redisId: true, appName: true, serverId: true } },
					compose: {
						columns: { composeId: true, appName: true, serverId: true },
					},
					libsql: {
						columns: { libsqlId: true, appName: true, serverId: true },
					},
				},
				orderBy: [desc(volumeBackups.createdAt)],
			});
		}),
	create: protectedProcedure
		.input(createVolumeBackupSchema)
		.mutation(async ({ input, ctx }) => {
			const { type: serviceType, id: serviceId } =
				await checkVolumeBackupAccess(ctx, input, "create");
			await assertServiceVolume(
				serviceType,
				serviceId,
				input.volumeName,
				input.serviceName,
			);
			if (IS_CLOUD && serviceType && serviceId) {
				const existingVolumeBackups = await db.query.volumeBackups.findMany({
					where: eq(volumeBackups[`${serviceType}Id`], serviceId),
				});
				await assertVolumeBackupLimit(
					ctx.session.activeOrganizationId,
					existingVolumeBackups.length,
				);
			}
			const newVolumeBackup = await createVolumeBackup(input);

			if (newVolumeBackup?.enabled) {
				if (IS_CLOUD) {
					await schedule({
						cronSchedule: newVolumeBackup.cronExpression,
						volumeBackupId: newVolumeBackup.volumeBackupId,
						type: "volume-backup",
					});
				} else {
					await scheduleVolumeBackup(newVolumeBackup.volumeBackupId);
				}
			}
			await audit(ctx, {
				action: "create",
				resourceType: "volumeBackup",
				resourceId: newVolumeBackup?.volumeBackupId,
			});
			return newVolumeBackup;
		}),
	one: protectedProcedure
		.input(
			z.object({
				volumeBackupId: z.string().min(1),
			}),
		)
		.query(async ({ input, ctx }) => {
			const vb = await findVolumeBackupById(input.volumeBackupId);
			await checkVolumeBackupAccess(ctx, vb, "read");
			return vb;
		}),
	delete: protectedProcedure
		.input(
			z.object({
				volumeBackupId: z.string().min(1),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			const vb = await findVolumeBackupById(input.volumeBackupId);
			await checkVolumeBackupAccess(ctx, vb, "delete");
			const result = await removeVolumeBackup(input.volumeBackupId);
			await audit(ctx, {
				action: "delete",
				resourceType: "volumeBackup",
				resourceId: input.volumeBackupId,
			});
			return result;
		}),
	update: protectedProcedure
		.input(updateVolumeBackupSchema)
		.mutation(async ({ input, ctx }) => {
			const existingVb = await findVolumeBackupById(input.volumeBackupId);
			await checkVolumeBackupAccess(ctx, existingVb, "update");
			const service = await checkVolumeBackupAccess(
				ctx,
				{ ...existingVb, ...input },
				"update",
			);
			await assertServiceVolume(
				service.type,
				service.id,
				input.volumeName,
				input.serviceName,
			);
			const updatedVolumeBackup = await updateVolumeBackup(
				input.volumeBackupId,
				input,
			);

			if (!updatedVolumeBackup) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Volume backup not found",
				});
			}

			if (IS_CLOUD) {
				if (updatedVolumeBackup.enabled) {
					await updateJob({
						cronSchedule: updatedVolumeBackup.cronExpression,
						volumeBackupId: updatedVolumeBackup.volumeBackupId,
						type: "volume-backup",
					});
				} else {
					await removeJob({
						cronSchedule: updatedVolumeBackup.cronExpression,
						volumeBackupId: updatedVolumeBackup.volumeBackupId,
						type: "volume-backup",
					});
				}
			} else {
				if (updatedVolumeBackup?.enabled) {
					removeVolumeBackupJob(updatedVolumeBackup.volumeBackupId);
					scheduleVolumeBackup(updatedVolumeBackup.volumeBackupId);
				} else {
					removeVolumeBackupJob(updatedVolumeBackup.volumeBackupId);
				}
			}
			await audit(ctx, {
				action: "update",
				resourceType: "volumeBackup",
				resourceId: updatedVolumeBackup.volumeBackupId,
			});
			return updatedVolumeBackup;
		}),

	runManually: protectedProcedure
		.input(z.object({ volumeBackupId: z.string().min(1) }))
		.mutation(async ({ input, ctx }) => {
			const vb = await findVolumeBackupById(input.volumeBackupId);
			const service = await checkVolumeBackupAccess(ctx, vb, "create");
			await assertServiceVolume(
				service.type,
				service.id,
				vb.volumeName,
				vb.serviceName,
			);
			try {
				const result = await runVolumeBackup(input.volumeBackupId);
				await audit(ctx, {
					action: "run",
					resourceType: "volumeBackup",
					resourceId: input.volumeBackupId,
				});
				return result;
			} catch (error) {
				console.error(error);
				return false;
			}
		}),
	restoreVolumeBackupWithLogs: withPermission("volumeBackup", "restore")
		.meta({
			openapi: {
				enabled: false,
				path: "/restore-volume-backup-with-logs",
				method: "POST",
				override: true,
			},
		})
		.input(
			z.object({
				backupFileName: z.string().min(1),
				destinationId: z.string().min(1),
				volumeName: z
					.string()
					.min(1)
					.regex(VOLUME_NAME_REGEX, VOLUME_NAME_MESSAGE),
				id: z.string().min(1),
				serviceType: z.enum(["application", "compose"]),
				serverId: z.string().optional(),
			}),
		)
		.subscription(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.id, {
				volumeBackup: ["restore"],
			});
			const serviceServerId = await assertDeclaredServiceVolume(
				input.serviceType,
				input.id,
				input.volumeName,
			);
			if ((input.serverId || null) !== (serviceServerId || null)) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "Restore server does not match the service",
				});
			}
			const destination = await findDestinationById(input.destinationId);
			if (destination.organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You don't have access to this destination.",
				});
			}
			if (input.serverId) {
				const targetServer = await findServerById(input.serverId);
				if (targetServer.organizationId !== ctx.session.activeOrganizationId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You don't have access to this server.",
					});
				}
			}
			return observable<string>((emit) => {
				const runRestore = async () => {
					try {
						emit.next("🚀 Starting volume restore process...");
						emit.next(`📂 Backup File: ${input.backupFileName}`);
						emit.next(`🔧 Volume Name: ${input.volumeName}`);
						emit.next(`🏷️ Service Type: ${input.serviceType}`);
						emit.next(""); // Empty line for better readability

						// Generate the restore command
						const restoreCommand = await restoreVolume(
							input.id,
							input.destinationId,
							input.volumeName,
							input.backupFileName,
							input.serverId || "",
							input.serviceType,
						);

						emit.next("📋 Generated restore command:");
						emit.next("▶️ Executing restore...");
						emit.next(""); // Empty line

						// Execute the restore command with real-time output
						if (input.serverId) {
							emit.next(`🌐 Executing on remote server: ${input.serverId}`);
							await execAsyncRemote(input.serverId, restoreCommand, (data) => {
								emit.next(data);
							});
						} else {
							emit.next("🖥️ Executing on local server");
							await execAsyncStream(restoreCommand, (data) => {
								emit.next(data);
							});
						}

						emit.next("");
						emit.next("✅ Volume restore completed successfully!");
						emit.next(
							"🎉 All containers/services have been restarted with the restored volume.",
						);
					} catch {
						emit.next("");
						emit.next("❌ Volume restore failed!");
					} finally {
						emit.complete();
					}
				};

				// Start the restore process
				runRestore();
			});
		}),
});
