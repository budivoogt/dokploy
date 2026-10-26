import { constants, promises as fs } from "node:fs";
import path from "node:path";

const contained = (root: string, target: string) =>
	target.startsWith(`${root}${path.sep}`);

const openConfinedFile = async (
	root: string,
	filePath: string,
	write: boolean,
) => {
	const base = path.resolve(root);
	const target = path.resolve(base, filePath);
	if (!contained(base, target))
		throw new Error("File escapes configuration directory");
	const rootReal = await fs.realpath(base);
	let current = base;
	for (const part of path
		.relative(base, path.dirname(target))
		.split(path.sep)
		.filter(Boolean)) {
		current = path.join(current, part);
		const stat = await fs.lstat(current);
		if (stat.isSymbolicLink() || !stat.isDirectory())
			throw new Error("Symlink directory refused");
	}
	const parent = await fs.realpath(path.dirname(target));
	if (parent !== rootReal && !contained(rootReal, parent))
		throw new Error("File escapes configuration directory");
	const directory = await fs.open(
		parent,
		constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
	);
	try {
		const descriptorPath = `/proc/self/fd/${directory.fd}`;
		const actualParent = await fs.realpath(descriptorPath);
		if (actualParent !== rootReal && !contained(rootReal, actualParent))
			throw new Error("File escapes configuration directory");
		const entry = path.join(descriptorPath, path.basename(target));
		const stat = await fs.lstat(entry).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT" && write) return null;
			throw error;
		});
		if (stat?.isSymbolicLink() || (stat && !stat.isFile()))
			throw new Error("Non-regular file refused");
		const flags =
			constants.O_NOFOLLOW |
			constants.O_NONBLOCK |
			(write ? constants.O_WRONLY | constants.O_CREAT : constants.O_RDONLY);
		const file = await fs.open(entry, flags, 0o640);
		const opened = await file.stat();
		if (!opened.isFile() || opened.nlink !== 1) {
			await file.close();
			throw new Error("Non-private regular file refused");
		}
		return file;
	} finally {
		await directory.close();
	}
};

export const readConfinedFile = async (root: string, filePath: string) => {
	let file: Awaited<ReturnType<typeof openConfinedFile>> | undefined;
	try {
		file = await openConfinedFile(root, filePath, false);
		return await file.readFile("utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	} finally {
		await file?.close();
	}
};

export const writeConfinedFile = async (
	root: string,
	filePath: string,
	content: string,
) => {
	const file = await openConfinedFile(root, filePath, true);
	try {
		await file.truncate(0);
		await file.writeFile(content, "utf8");
	} finally {
		await file.close();
	}
};
