# JOY / FishVoice Scalability Assessment

## Current supported shape (source-level)

| Dimension | Current repository model | Constraint |
|---|---|---|
| ESP32s | One compile-time `MQTT_DEVICE_ID` per firmware configuration | No device registry, onboarding, provisioning, or collision prevention. |
| Outputs | One `RELAY_PIN`, `relayIsOn`, and `on`/`off` action | No output index, relay metadata, or multi-output state shape. |
| Users | One configured admin username/password | No user table, roles, membership, sharing, or per-device authorization. |
| Homes | None | No home/location boundary or timezone ownership. |
| Google links | Stateless OAuth token naming the single admin | No Google account-link table, link lifecycle, or multiple household users. |
| State | Retained MQTT state + on-demand backend reads | No central continuously updated state cache/consumer. |
| Commands | Per-request MQTT publish and request-ID acknowledgment | No durable queue, command ledger, expiry, ordering, or deduplication. |
| History | Activity events and per-device daily runtime | No retention/partitioning policy; runtime is poll-sampled. |

This assessment does not assert a tested maximum device count. Broker plan, database pool limits, Vercel concurrency, and deployed quotas were not available.

## Bottlenecks and risks

### 1. MQTT connection churn

`getDeviceStatus()` and `setDeviceState()` each create and close a TLS MQTT client for a request. Web and Android refresh status/activity/runtime every 15 seconds; Android background status polling runs every 30 seconds. Each status refresh adds a broker connect/subscribe/disconnect cycle. More clients increase broker connection count, TLS CPU, function duration, and correlated reconnect bursts.

**Practical step:** measure active and peak API clients, connection setup latency, broker concurrent/connection-rate quotas, and serverless concurrency before redesign. Keep the existing request flow for current scale if it meets measured SLOs. If it does not, use one bounded MQTT state consumer/managed bridge plus a database latest-state cache; leave command API and current device topics compatible.

### 2. Database and observation fidelity

Database state is updated by authenticated dashboard status requests only. A Google QUERY, Android background poll, or local HTTP command does not create the same observation. Runtime is counted only between successful samples within a 30-second gap. This makes telemetry and runtime dependent on which clients are open and how often polling succeeds.

**Practical step:** establish an event ingestion path from MQTT status messages, store last-seen timestamp and sequence/version, and derive runtime from trustworthy observations. Preserve current chart semantics during rollout and label historical values as observed estimates.

### 3. One-device configuration and one-relay firmware

The backend uses one `MQTT_DEVICE_ID` environment value, and Smart Home SYNC returns one hard-coded device. Firmware contains one GPIO and one relay state. Duplicate device IDs would share topics and MQTT client ID; there is no registry to reject duplicates.

**Practical step:** add a device inventory before adding more devices; provision a stable unique device identity and per-device credentials. Model each output explicitly. Any protocol change must be versioned and backward-compatible; keep current topic/message format unchanged during this audit and stabilization.

### 4. Single-account authorization

All dashboard and Google operations map to one admin identity. There is no authorization boundary for a household, location, user, device, or relay. Adding users without those relationships risks cross-home control and Google discovery leakage.

**Practical step:** add users/homes/memberships and require ownership checks at every API and fulfillment operation before exposing multi-user access.

### 5. Activity growth and query cost

Activity is cursor-paginated and indexed by creation time, but no retention, archive, or partition plan is visible. Runtime uses upserts keyed by device/day. The advisory lock provides per-device transaction serialization; pool sizing is not visible.

**Practical step:** define retention and export requirements, measure table growth and query plans, tune indexes and Prisma connection pooling against the actual hosting plan, then load-test.

### 6. Simultaneous commands

Each operation owns a broker client and waits for a correlated acknowledgment. There is no global ordering per device, durable request state, deduplication, or deadline on the firmware payload. Multiple concurrent opposite commands can race; the last command observed by firmware wins, and callers may see acknowledgments from their own request IDs but no central ordering record.

**Practical step:** before multi-device/high-concurrency use, add a per-device command coordinator/ledger with idempotency, expiry, status, and explicit conflict policy. Keep bounded concurrency and queue depth.

## Recommended target data model

Minimum relational model (not a microservice split):

- `User`: login identity, credential metadata, status.
- `Home`: owner, display/location metadata and timezone.
- `HomeMembership`: user, home, role, lifecycle.
- `Device`: immutable device identity, home, model/firmware, network/last-seen, provisioned status.
- `Output`: device, output key, display name, Google trait/type, configured safe/default state.
- `DeviceState`: latest reported online/output state, received time, source/version.
- `Command`: request ID/idempotency key, output, desired state, actor, issued/expiry time, result.
- `ActivityEvent`: device/output plus actor/home and timestamp.
- `GoogleAccountLink` / `OAuthGrant`: opaque stable Google agent identity, user/home authorization, revocable hashed refresh grant and lifecycle.
- `DeviceRuntimeDaily`: device/output/date with documented estimation source.

Migrate the existing device, output, and admin user as seeded records. Enforce database foreign keys, unique device/output identity, and tenant-scoped query constraints.

## Recommended service boundary

Keep the existing Next.js application as the API/OAuth/fulfillment application. Do not introduce multiple microservices by default.

1. For the present scale, retain per-request MQTT while measuring connection and function limits.
2. If load requires, add one durable state consumer (or broker-managed bridge) as a small isolated runtime. It subscribes to existing state topics, validates payloads, updates latest state/events, and triggers Google Report State through a bounded retry mechanism.
3. Keep commands on the existing topic/payload contract initially; the backend writes a command ledger and correlates acknowledgments.
4. Add a lightweight queue/outbox only if durable retries or Report State reliability require it. Avoid introducing a general event platform without measurable need.

## Growth stages and exit conditions

### Stage A: Existing single home

Secure OAuth and local control, validate one-device command/ack, add regression tests, verify safe startup/failover and deploy settings.

### Stage B: Multiple devices in one home

Add unique provisioning, device registry, device ownership, per-device MQTT credentials/ACLs, inventory-based SYNC/QUERY, state discovery, and two-device concurrency tests. Firmware must support unique IDs and, when needed, multiple outputs.

### Stage C: Multiple homes/users

Add role and membership checks, home-scoped API access, multiple Google linked accounts, unlink/revocation, opaque `agentUserId`, privacy isolation, household linking, and cross-tenant authorization tests.

### Stage D: Higher concurrency

Use observed load to decide whether to adopt a shared MQTT state consumer, cached state API, bounded command queue, database pooler, and event retention/partitioning. Define numeric SLOs and quotas before deployment.

## Capacity validation metrics

Collect and agree thresholds before launch:

- Peak and sustained device count, API clients per device, commands/minute, simultaneous commands.
- Broker current/max connections, connect rate, publish/subscription latency, rejected ACL/auth count.
- MQTT connect-to-ack p50/p95/p99, command timeout/duplicate/out-of-order rate, state age.
- Vercel function invocations, duration, concurrent executions, timeout/error count.
- PostgreSQL connection utilization, query latency, lock wait, table/index growth, transaction failure rate.
- Device online transition delay, reconnect time across Ethernet/Wi-Fi/AP, and Report State success/retry age.

The project has no evidence establishing those production limits today.
