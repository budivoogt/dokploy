import { db } from "@dokploy/server/db";
import { user } from "@dokploy/server/db/schema";
import {
	findMemberByUserId,
	type PermissionCtx,
} from "@dokploy/server/services/permission";
import { findServerById } from "@dokploy/server/services/server";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";

export const requireOrganizationAdmin = async (ctx: PermissionCtx) => {
	const member = await findMemberByUserId(
		ctx.user.id,
		ctx.session.activeOrganizationId,
	);
	if (member.role !== "owner" && member.role !== "admin") {
		throw new TRPCError({ code: "UNAUTHORIZED" });
	}
};

export const requirePanelOwner = async (ctx: PermissionCtx) => {
	const account = await db.query.user.findFirst({
		where: eq(user.id, ctx.user.id),
		columns: { role: true },
	});
	if (account?.role !== "owner") throw new TRPCError({ code: "UNAUTHORIZED" });
	await requireOrganizationAdmin(ctx);
};

export const assertServerOrganization = async (
	ctx: PermissionCtx,
	serverId?: string | null,
) => {
	if (!serverId) return;
	const server = await findServerById(serverId);
	if (server.organizationId !== ctx.session.activeOrganizationId) {
		throw new TRPCError({ code: "UNAUTHORIZED" });
	}
	return server;
};
