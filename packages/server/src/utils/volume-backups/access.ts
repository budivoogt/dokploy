import { quote } from "shell-quote";
import { parse } from "yaml";
import { findApplicationById } from "../../services/application";
import { findComposeById } from "../../services/compose";
import { findLibsqlById } from "../../services/libsql";
import { findMariadbById } from "../../services/mariadb";
import { findMongoById } from "../../services/mongo";
import { findMountsByApplicationId } from "../../services/mount";
import { findMySqlById } from "../../services/mysql";
import { findPostgresById } from "../../services/postgres";
import { findRedisById } from "../../services/redis";
import { execAsync, execAsyncRemote } from "../process/execAsync";

const loaders = {
	application: (id: string) => findApplicationById(id),
	compose: (id: string) => findComposeById(id),
	postgres: (id: string) => findPostgresById(id),
	mysql: (id: string) => findMySqlById(id),
	mariadb: (id: string) => findMariadbById(id),
	mongo: (id: string) => findMongoById(id),
	redis: (id: string) => findRedisById(id),
	libsql: (id: string) => findLibsqlById(id),
};
type ServiceType = keyof typeof loaders;
type VolumeTarget = Partial<Record<`${ServiceType}Id`, string | null>> & {
	serviceType: string;
};

export const volumeBackupService = (target: VolumeTarget) => {
	const types = (Object.keys(loaders) as ServiceType[]).filter(
		(type) => target[`${type}Id`],
	);
	const type = types[0];
	if (types.length !== 1 || !type || target.serviceType !== type) {
		throw new Error(
			"A volume backup must declare exactly one matching service",
		);
	}
	return { type, id: target[`${type}Id`] as string };
};

const record = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);

const declaredComposeVolume = (
	compose: Awaited<ReturnType<typeof findComposeById>>,
	volumeName: string,
) => {
	if (
		compose.sourceType !== "raw" ||
		compose.command ||
		compose.randomize ||
		compose.isolatedDeployment
	)
		return false;
	const config: unknown = parse(compose.composeFile);
	if (!record(config) || !record(config.volumes) || !record(config.services))
		return false;
	for (const service of Object.values(config.services)) {
		if (!record(service) || !Array.isArray(service.volumes)) continue;
		for (const mount of service.volumes) {
			const source =
				typeof mount === "string"
					? mount.includes(":")
						? mount.split(":")[0]
						: undefined
					: record(mount) && mount.type === "volume"
						? mount.source
						: undefined;
			if (typeof source !== "string" || !Object.hasOwn(config.volumes, source))
				continue;
			const definition = config.volumes[source];
			if (definition !== null && !record(definition)) continue;
			if (
				definition?.external !== undefined &&
				typeof definition.external !== "boolean"
			)
				continue;
			const name =
				definition && typeof definition.name === "string"
					? definition.name
					: definition?.external === true
						? source
						: `${compose.appName}_${source}`;
			if (name === volumeName) return true;
		}
	}
	return false;
};

export const assertDeclaredServiceVolume = async (
	type: "application" | "compose",
	id: string,
	volumeName: string,
) => {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(volumeName))
		throw new Error("Invalid volume name");
	const service = await loaders[type](id);
	const mounts = await findMountsByApplicationId(id, type);
	const declared = mounts.some((mount) => {
		if (
			mount.type !== "volume" ||
			mount.volumeName !== volumeName ||
			mount.serviceType !== type
		)
			return false;
		const ids = (Object.keys(loaders) as ServiceType[]).filter(
			(kind) => mount[`${kind}Id`],
		);
		return ids.length === 1 && mount[`${type}Id`] === id;
	});
	if (
		!declared &&
		!(
			type === "compose" &&
			"composeFile" in service &&
			declaredComposeVolume(service, volumeName)
		)
	) {
		throw new Error("Volume does not belong to the declared service");
	}
	return service.serverId;
};

export const assertServiceVolume = async (
	type: ServiceType,
	id: string,
	volumeName: string,
	serviceName?: string | null,
) => {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(volumeName))
		throw new Error("Invalid volume name");
	const service = await loaders[type](id);
	const serverId = service.serverId;
	const run = (command: string) =>
		serverId ? execAsyncRemote(serverId, command) : execAsync(command);
	const filters =
		type === "compose"
			? "composeType" in service && service.composeType === "stack"
				? [
						`label=com.docker.stack.namespace=${service.appName}`,
						...(serviceName
							? [
									`label=com.docker.swarm.service.name=${service.appName}_${serviceName}`,
								]
							: []),
					]
				: [
						`label=com.docker.compose.project=${service.appName}`,
						...(serviceName
							? [`label=com.docker.compose.service=${serviceName}`]
							: []),
					]
			: [`label=com.docker.swarm.service.name=${service.appName}`];
	const { stdout } = await run(
		quote([
			"docker",
			"ps",
			"--all",
			"--quiet",
			...filters.flatMap((filter) => ["--filter", filter]),
		]),
	);
	const ids = stdout.trim().split(/\s+/).filter(Boolean);
	if (
		!ids.length ||
		ids.length > 1000 ||
		ids.some((container) => !/^[a-f0-9]{12,64}$/.test(container))
	) {
		throw new Error("Cannot establish service volume ownership");
	}
	const inspected = await run(
		quote(["docker", "inspect", "--format", "{{json .Mounts}}", ...ids]),
	);
	const ownsVolume = inspected.stdout
		.trim()
		.split("\n")
		.some((line) => {
			const mounts: unknown = JSON.parse(line);
			return (
				Array.isArray(mounts) &&
				mounts.some(
					(mount) => mount?.Type === "volume" && mount.Name === volumeName,
				)
			);
		});
	if (!ownsVolume)
		throw new Error("Volume does not belong to the declared service");
	return serverId;
};
