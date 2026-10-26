import {
	findMemberByUserId,
	type PermissionCtx,
} from "@dokploy/server/services/permission";
import { findServerById } from "@dokploy/server/services/server";
import { TRPCError } from "@trpc/server";

export const requireOrganizationAdmin = async (ctx: PermissionCtx) => {
	const member = await findMemberByUserId(
		ctx.user.id,
		ctx.session.activeOrganizationId,
	);
	if (member.role !== "owner" && member.role !== "admin") {
		throw new TRPCError({ code: "UNAUTHORIZED" });
	}
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
