import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	readConfinedFile,
	writeConfinedFile,
} from "@dokploy/server/utils/filesystem/confined-file";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let temporary: string;
let root: string;
let outside: string;
beforeEach(async () => {
	temporary = await fs.mkdtemp(path.join(os.tmpdir(), "dokploy-confined-"));
	root = path.join(temporary, "traefik");
	outside = path.join(temporary, "outside");
	await fs.mkdir(root);
	await fs.mkdir(outside);
	await fs.writeFile(path.join(outside, "secret"), "unchanged");
});
afterEach(async () => {
	await fs.rm(temporary, { recursive: true, force: true });
});

describe("Traefik file confinement", () => {
	it("reads, creates and replaces regular files inside the directory", async () => {
		const file = path.join(root, "config.yml");
		await writeConfinedFile(root, file, "first");
		await writeConfinedFile(root, file, "http: {}");
		expect(await readConfinedFile(root, file)).toBe("http: {}");
		expect(await readConfinedFile(root, path.join(root, "missing"))).toBeNull();
	});
	it("refuses a symlink leaf without modifying or disclosing its target", async () => {
		const file = path.join(root, "config.yml");
		await fs.symlink(path.join(outside, "secret"), file);
		await expect(readConfinedFile(root, file)).rejects.toThrow();
		await expect(writeConfinedFile(root, file, "changed")).rejects.toThrow();
		expect(await fs.readFile(path.join(outside, "secret"), "utf8")).toBe(
			"unchanged",
		);
	});
	it("refuses symlink parents even when the lexical path is contained", async () => {
		await fs.symlink(outside, path.join(root, "dynamic"));
		const file = path.join(root, "dynamic", "secret");
		await expect(readConfinedFile(root, file)).rejects.toThrow();
		await expect(writeConfinedFile(root, file, "changed")).rejects.toThrow();
		expect(await fs.readFile(path.join(outside, "secret"), "utf8")).toBe(
			"unchanged",
		);
	});
	it("refuses hard-linked files and sibling directories", async () => {
		const file = path.join(root, "linked.yml");
		await fs.link(path.join(outside, "secret"), file);
		await expect(writeConfinedFile(root, file, "changed")).rejects.toThrow();
		await expect(
			readConfinedFile(root, path.join(outside, "secret")),
		).rejects.toThrow();
		expect(await fs.readFile(path.join(outside, "secret"), "utf8")).toBe(
			"unchanged",
		);
	});
});
