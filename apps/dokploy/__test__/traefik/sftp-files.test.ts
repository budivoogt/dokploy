import { writeSftpFile } from "@dokploy/server/utils/filesystem/sftp-file";
import type { SFTPWrapper } from "ssh2";
import { describe, expect, it, vi } from "vitest";

const session = (symlink: "parent" | "leaf" | null = null) => {
	const regular = {
		isFile: () => true,
		isDirectory: () => false,
		isSymbolicLink: () => false,
	};
	const directory = {
		isFile: () => false,
		isDirectory: () => true,
		isSymbolicLink: () => false,
	};
	const link = {
		isFile: () => false,
		isDirectory: () => false,
		isSymbolicLink: () => true,
	};
	return {
		realpath: vi.fn((_path, callback) => callback(null, "/tmp/traefik")),
		lstat: vi.fn((file: string, callback) =>
			callback(
				null,
				file.endsWith("config.yml")
					? symlink === "leaf"
						? link
						: regular
					: symlink === "parent"
						? link
						: directory,
			),
		),
		writeFile: vi.fn((_file, _content, _options, callback) => callback(null)),
		ext_openssh_rename: vi.fn((_from, _to, callback) => callback(null)),
		unlink: vi.fn((_file, callback) => callback(null)),
	};
};

describe("SFTP file replacement", () => {
	it.each(["parent", "leaf"] as const)(
		"refuses a symlink %s without writing data",
		async (symlink) => {
			const sftp = session(symlink);
			await expect(
				writeSftpFile(
					sftp as unknown as SFTPWrapper,
					"/tmp/traefik/config.yml",
					"http: {}",
				),
			).rejects.toThrow();
			expect(sftp.writeFile).not.toHaveBeenCalled();
			expect(sftp.ext_openssh_rename).not.toHaveBeenCalled();
		},
	);
	it("writes an exclusive sibling and replaces the directory entry atomically", async () => {
		const sftp = session();
		await writeSftpFile(
			sftp as unknown as SFTPWrapper,
			"/tmp/traefik/config.yml",
			"http: {}",
		);
		const temporary = sftp.writeFile.mock.calls[0]?.[0];
		expect(temporary).toMatch(/^\/tmp\/traefik\/\.dokploy-[a-f0-9-]+\.tmp$/);
		expect(sftp.writeFile).toHaveBeenCalledWith(
			temporary,
			"http: {}",
			{ flag: "wx", mode: 0o640 },
			expect.any(Function),
		);
		expect(sftp.ext_openssh_rename).toHaveBeenCalledWith(
			temporary,
			"/tmp/traefik/config.yml",
			expect.any(Function),
		);
	});
});
