import { randomUUID } from "node:crypto";
import path from "node:path";
import type { SFTPWrapper, Stats } from "ssh2";

const checkParent = async (sftp: SFTPWrapper, target: string) => {
	if (!path.posix.isAbsolute(target))
		throw new Error("Absolute remote file path required");
	const parent = path.posix.dirname(path.posix.resolve(target));
	const real = await new Promise<string>((resolve, reject) =>
		sftp.realpath(parent, (error, value) =>
			error ? reject(error) : resolve(value),
		),
	);
	if (real !== parent) throw new Error("Remote symlink directory refused");
	let current = "/";
	for (const part of parent.split("/").filter(Boolean)) {
		current = path.posix.join(current, part);
		const stat = await new Promise<Stats>((resolve, reject) =>
			sftp.lstat(current, (error, value) =>
				error ? reject(error) : resolve(value),
			),
		);
		if (stat.isSymbolicLink() || !stat.isDirectory())
			throw new Error("Remote symlink directory refused");
	}
	const stat = await new Promise<Stats | null>((resolve, reject) =>
		sftp.lstat(target, (error, value) => {
			if (error && "code" in error && error.code === 2) resolve(null);
			else if (error) reject(error);
			else resolve(value);
		}),
	);
	if (stat && !stat.isFile())
		throw new Error("Remote non-regular file refused");
};

export const writeSftpFile = async (
	sftp: SFTPWrapper,
	target: string,
	content: string,
) => {
	await checkParent(sftp, target);
	const temporary = path.posix.join(
		path.posix.dirname(target),
		`.dokploy-${randomUUID()}.tmp`,
	);
	try {
		await new Promise<void>((resolve, reject) =>
			sftp.writeFile(
				temporary,
				content,
				{ flag: "wx", mode: 0o640 },
				(error) => (error ? reject(error) : resolve()),
			),
		);
		await checkParent(sftp, target);
		await new Promise<void>((resolve, reject) =>
			sftp.ext_openssh_rename(temporary, target, (error) =>
				error ? reject(error) : resolve(),
			),
		);
	} finally {
		await new Promise<void>((resolve) =>
			sftp.unlink(temporary, () => resolve()),
		);
	}
};
