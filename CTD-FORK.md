# Contracko Dokploy fork

## Base and provenance

The candidate uses upstream **v0.30.10**, commit `073713f0b863eca4285ad24db00550af1b39397a`. Retained patches come from fork `6cdb4ce1a45903c5583fd668fb65e77729a8a816` plus Node PR [#8](https://github.com/budivoogt/dokploy/pull/8), `18e7c3288dd8b2c3cbe8c0ac6039474f7a8db638`.

The earlier fork contains duplicate logical patches from its previous rebase. This candidate replays their net delta onto the exact upstream release and retains the old commits for provenance. Historical host configuration and synthetic rehearsal directories are outside this application patch stack.

## Patch verdicts against v0.29.14..v0.30.10

| Patch | Verdict | Evidence and resolution | Hosted regression |
| --- | --- | --- | --- |
| Preview teardown race | Keep, adapt webhook | Upstream [#4209](https://github.com/Dokploy/dokploy/pull/4209) remains open. At `073713f0b`, preview builds still reach service creation without checking whether teardown removed the record. Keep existence checks, idempotent teardown and queue guards. Preserve upstream [#5079](https://github.com/Dokploy/dokploy/pull/5079), `fc6f4d9af`, applying limits only to new previews. | Queue and webhook suites |
| GitHub Deployments API | Keep | At `073713f0b`, no upstream `services/github-deployment.ts` equivalent exists. Keep preview and persistent deployment/redeployment status, PR-close deactivation and App permission. | GitHub deployment and webhook suites |
| Deploy secret hygiene | Adapt, preserve upstream SFTP | Upstream `68a05551d` moves remote Traefik writes to SFTP but does not stage clone/build/registry credentials outside argv. Keep secret files, remote cleanup and log redaction alongside upstream `writeFileRemote`. Replace unscoped askpass with a credential helper that releases credentials only for the configured protocol and host, preventing unrelated recursive submodules from obtaining provider tokens. | Secret files, credential origin isolation, redaction, provider argv and injection suites |
| Digest-safe mirroring | Keep | Upstream `073713f0b:packages/server/src/utils/cluster/upload.ts` still copies `@sha256` into mirror destinations. Keep original pinned sources and deterministic `:sha256-<digest>` destinations. | Cluster upload suite |
| Hung-job watchdog | Keep, adapt compose | Upstream `36ba9fcb3` adds `freshVolumes`, without bounded timeout recovery. Preserve the option with timeout, status reset and queue-group blocking. Timeout does not cancel the underlying operation. | Deployment queue and in-memory queue suites |
| TLS without resolver | Keep | Upstream `073713f0b:packages/server/src/utils/traefik/domain.ts` still sets TLS undefined for certificate type none. Keep `tls: {}` for loaded certificates without ACME, preserving domain enable/disable `ee802cd54`. | Traefik suite |
| Node 24.22.1 | Drop duplicate version edits, retain digest pin/check | Upstream [#5738](https://github.com/Dokploy/dokploy/pull/5738), `aa2ed35b4144d83860f98b87490999a993b3906e`, updates all Node versions, engine floors and contributor instructions. Retain PR #8 immutable image pins and exact published runtime check. | Published digest must report `v24.22.1` |

Preserve upstream provider-secret response filtering `a42614004` and SSO enforcement `b839e6d6b`/`5f10ed688`. Retain earlier fork security fixes: cross-organization provider reference/mutation checks, licensed organization-scoped SCIM issuance, archive extraction safety, dependency overrides, migration failure exit status and runtime release identity. Existing security regression suites run before publication. Keep TypeScript 7 and update Next to the compatible patched 16.4.1 release. Align the app Nano ID pin with upstream server 3.3.18, preserving the old fork's 3.3.17 floor instead of regressing to upstream app 3.3.11.

## Image pins

Node: `node:24.22.1-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205`, measured for PR #8, whose published runtime passed the version check. The Bookworm slim image serves both application stages and the cloud, schedule, server and development Dockerfiles.

The Node 24 slim registry pin was rechecked on 26 October 2026 and remains current. Both build and runtime stages upgrade OS packages before cleaning apt lists. Docker CLI 29.9.2 comes from an immutable official image digest. Pack 0.40.10, Railpack 0.43.0, Buildx 0.38.1 and Compose 5.6.1 use release assets with fixed SHA-256 checksums. Nixpacks 1.41.0 and rclone 1.75.2 remain the latest releases and now use fixed asset checksums too. The Dockerfile owns all exact pins. Preserve upstream `dec05aca2` tini entrypoint for healthcheck child reaping. Runtime retains the Docker CLI without a Docker daemon or unnecessary package managers.

## Database migrations since v0.29.14

No fork SQL migrations are added or changed. Upstream adds:

| Migration | Change |
| --- | --- |
| 0180 slippery_norrin_radd | Compose createEnvFile default true |
| 0181 dashing_havok | Vault provider enum/table, organization foreign key, unique name index |
| 0182 skinny_wild_pack | Organization default_role |
| 0183 tearful_groot | Domain enabled default true |
| 0184 wonderful_absorbing_man | Scaleway vault enum value |
| 0185 needy_kingpin | DNS provider enum/table, organization foreign key, unique name index |
| 0186 tearful_dragon_man | Network dockerId |
| 0187 grant_terminal_permission_to_read_roles | Grants server.terminal to existing custom roles with server.read |
| 0188 volatile_piledriver | Phase vault enum value |
| 0189 wooden_nextwave | Porkbun DNS enum value |
| 0190 nappy_anita_blake | User onboarding timestamp plus existing-user backfill |
| 0191 cool_christian_walker | Infomaniak DNS enum value |
| 0192 light_lake | OVH DNS enum value |
| 0193 chemical_the_liberteens | AWS Parameter Store vault enum value |
| 0194 acoustic_prima | SSO domain_verified default true |
| 0195 classy_whirlwind | Whitelabel JSON default adds Open Graph image |

A v0.29 database requires a recoverable backup before migration. Enum additions and data backfills have no automatic down migrations. Reverting only the image is not database rollback. The first target already runs fresh upstream v0.30.10, so this swap introduces no schema delta; the host owner must verify its migration journal.

## Publication and handoff

### Stable security refresh, 26 October 2026

The latest stable release remains v0.30.10, published 22 October 2026. The fork already contains its exact upstream tree plus the carried patches above, so a second stable merge has no source delta. Keep every functional fork patch. The duplicate Node version edit remains dropped; immutable runtime pins and publication checks remain.

Backport the service and project ownership checks from upstream security commit [b3cd3c506](https://github.com/Dokploy/dokploy/commit/b3cd3c5061b9e4f9a786dc4a048765f79bae2523). [CVE-2026-116068](https://nvd.nist.gov/vuln/detail/CVE-2026-116068) affects upstream through v0.30.10: owners and administrators can pass service permission checks for another organization. The same shared check is used by the port router implicated in [CVE-2026-111331](https://nvd.nist.gov/vuln/detail/CVE-2026-111331); the missing ownership check is still present in this stable source despite that record naming versions through v0.30.8. The backport enforces ownership before role permissions and retains per-member service restrictions. No schema migration is added. Cross-organization denial and same-organization access regressions run in the publication gate.

Carry the related security hunks from the same upstream commit: organization-bound backup and volume-backup destinations at request and execution time, certificate path confinement and server-generated certificate paths, and server-side Compose branch validation. Adapt deployment-log access to resolve backup and preview IDs to their owning service before the new ownership check. Retain the fork's credential files and origin isolation instead of upstream's credential-in-command headers. Notification log-tail changes are outside this security backport. No database migration is added. Hosted regressions cover these boundaries before publication.

Also backport Traefik file path confinement from [1f1acacf5](https://github.com/Dokploy/dokploy/commit/1f1acacf585238f9a8f86f8b2a9ad1cb23834deb) and remote file-editor ownership checks from [136a09d01](https://github.com/Dokploy/dokploy/commit/136a09d0161e46fbab14a1872c7c7149a580ed89). [CVE-2026-82954](https://nvd.nist.gov/vuln/detail/CVE-2026-82954) lists versions through v0.29.7, but the stable write route still passes an unconstrained caller path. Reject absolute and relative escapes and foreign servers before file operations. Local editor access uses realpath containment, rejects symlink directories and files, and opens files with O_NOFOLLOW through a retained directory descriptor. It requires Linux procfs, as provided by the runtime image. Remote arbitrary-path reading and writing are disabled because SFTP cannot provide that same race-safe boundary. Internal SFTP writes reject symlinks and replace an exclusively created sibling through OpenSSH atomic rename; servers without that extension fail closed.

Close the inherited authorization exceptions too. Whole-panel restore through the API is disabled for every role. Service-less backup operations require an active organization owner or administrator and an organization-owned destination. Deployment logs and actions resolve every supported owning resource, including local schedules, and deny unknown ownership. Global queues and server deployment listings require organization administration. Volume backups declare exactly one service, check its permissions and destination, and verify the named volume against that service's actual Docker mounts before backup or restoration. Restore also binds its server to the owning service. All settings administration with a serverId checks that server's organization before effects. Focused hosted regressions cover each boundary.

The publication workflow scans the exact pushed digest with Trivy v0.76.1. It includes OS and library vulnerabilities at every severity, including unknown and unfixed findings, and retains the complete JSON inventory. Scanner failure fails publication validation; vulnerability findings remain visible for explicit disposition and do not imply deployment approval. Source authorization bugs require the regression gate and advisory review, since package scanners do not establish application authorization safety.

Publication uses the built-in repository token. PR jobs request read permissions only. The publisher runs on explicit dispatch from the default branch, currently canary, or a version tag; it verifies that the default branch is protected and that the selected commit belongs to its history before registry login. Ordinary branch pushes and PRs do not publish or deploy. Hosted regressions must pass before amd64 build/push. OCI/runtime metadata records the source SHA and release tag. Node is measured from the pushed digest with networking disabled.

Before enabling publication, protect canary with pull requests and the required regression check, require current checks, and block force pushes and deletion. Require review when a distinct reviewer identity is available. For a user-owned package without repository linkage, the owner adds this repository with Write under Package settings, Manage Actions access. After merge, the owner removes the old account-level registry secret. Workflow permissions alone are not an immutable ceiling against a same-repository PR that edits workflow YAML; deployment must retain exact digest and trusted default-branch build provenance checks.

Candidate tags use `ghcr.io/budivoogt/dokploy:v0.30.10-ctd<sha7>`. Hand off the complete tag@digest and successful workflow URL. The PR and handoff record the final digest, avoiding a source change merely to record its own image identity. Branch tags are discovery aids only.

This task publishes only. The migration owner performs the separately authorized image swap on its v0.30.10 installation. The old production host is outside this upgrade. The retained legacy rollout script defaults to the old host and must not be used for the new target.

Before updating, capture the prior exact image, verify recoverable control-plane backups and preserve authentication/encryption secrets. A stop-first service has control-plane interruption during replacement. A null service-level healthcheck does not disable the Dockerfile inherited healthcheck. The owner verifies actual service settings and readiness after the swap. No start-first conversion or secret migration is authorized by publication.

The rollback digest must be confirmed available in the registry, or retained in the target's local image store and protected from pruning, before any patch rollout is approved.
