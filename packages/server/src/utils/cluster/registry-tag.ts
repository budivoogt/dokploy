import type { Registry } from "@dokploy/server/services/registry";

/**
 * Extract the repository name from imageName by taking the last part after '/'.
 * Digest references are converted to deterministic, Docker-compatible tags when
 * the image is mirrored to another registry.
 */
const extractRepositoryName = (imageName: string): string => {
	const lastSlashIndex = imageName.lastIndexOf("/");
	const repositoryName =
		lastSlashIndex === -1 ? imageName : imageName.substring(lastSlashIndex + 1);
	const digestReference = repositoryName.match(
		/^([^:]+)(?::[^@]+)?@sha256:([0-9a-f]{64})$/i,
	);

	if (!digestReference) {
		return repositoryName;
	}

	const name = digestReference[1];
	const digest = digestReference[2];
	if (!name || !digest) {
		return repositoryName;
	}

	return `${name}:sha256-${digest.toLowerCase()}`;
};

export const getRegistryTag = (registry: Registry, imageName: string) => {
	const { registryUrl, imagePrefix, username } = registry;
	const repositoryName = extractRepositoryName(imageName);
	const targetPrefix = (imagePrefix || username).toLowerCase();
	const finalRegistry = registryUrl || "";

	return finalRegistry
		? `${finalRegistry}/${targetPrefix}/${repositoryName}`
		: `${targetPrefix}/${repositoryName}`;
};
