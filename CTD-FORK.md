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

Preserve upstream provider-secret response filtering `a42614004` and SSO enforcement `b839e6d6b`/`5f10ed688`. Retain earlier fork security fixes: cross-organization provider reference/mutation checks, licensed organization-scoped SCIM issuance, archive extraction safety, dependency overrides, migration failure exit status and runtime release identity. Existing security regression suites run before publication. Keep newer upstream Next 16.3 and TypeScript 7. Align the app Nano ID pin with upstream server 3.3.18, preserving the old fork's 3.3.17 floor instead of regressing to upstream app 3.3.11.

## Image pins

Node: `node:24.22.1-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205`, measured for PR #8, whose published runtime passed the version check. The Bookworm slim image serves both application stages and the cloud, schedule, server and development Dockerfiles.

Pack: `buildpacksio/pack:0.40.9@sha256:4aec804c59165df9392e784d19a64d773b7bf886e020ef07b187a0f52bef64bf`, measured from the registry on 22 October 2026. Preserve upstream `dec05aca2` tini entrypoint for healthcheck child reaping. Runtime retains the Docker CLI without a Docker daemon or unnecessary package managers.

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

Only explicit dispatch of `.github/workflows/ctd-image.yml` publishes images. Ordinary pushes/PRs never publish or deploy. Hosted regressions must pass before amd64 build/push. OCI/runtime metadata records the source SHA and release tag. Node is measured from the pushed digest with networking disabled.

Candidate tags use `ghcr.io/budivoogt/dokploy:v0.30.10-ctd<sha7>`. Hand off the complete tag@digest and successful workflow URL. The PR and handoff record the final digest, avoiding a source change merely to record its own image identity. Branch tags are discovery aids only.

This task publishes only. The migration owner performs the separately authorized image swap on its v0.30.10 installation. The old production host is outside this upgrade. The retained legacy rollout script defaults to the old host and must not be used for the new target.

Before updating, capture the prior exact image, verify recoverable control-plane backups and preserve authentication/encryption secrets. A stop-first service has control-plane interruption during replacement. A null service-level healthcheck does not disable the Dockerfile inherited healthcheck. The owner verifies actual service settings and readiness after the swap. No start-first conversion or secret migration is authorized by publication.
