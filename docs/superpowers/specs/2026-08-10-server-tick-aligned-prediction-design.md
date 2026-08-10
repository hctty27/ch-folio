# Server-Tick Aligned Prediction Design

Date: 2026-08-10
Status: Proposed
Scope: protocol-v2 client prediction/reconciliation smoothness; Node authority remains authoritative

## Problem

Protocol-v2 is now driveable, but public play remains visibly hitchy. The current implementation has three structural causes:

1. `AuthoritativeMultiplayer.update()` advances `PredictionWorld` from the browser's local fixed-step clock. `InputPublisher` serializes that local prediction tick as `input.clientTick`.
2. `RoomSimulation` consumes input on a server-owned timeline with a three-tick input buffer. When an input arrives after its `clientTick` has already been consumed, the server currently coalesces it forward to the next unconsumed input tick. The client is not told that the server changed the tick associated with that sequence.
3. `Reconciler` decides whether to rollback from the whole-world checksum. A client does not have every remote player's live input stream, so remote movement can make the world checksum differ even when the local owner's prediction is acceptable.

Visual smoothing cannot remove a rollback that is being triggered repeatedly by a timeline mismatch. The replacement design aligns local prediction to the server tick, predicts only the local owner, and interpolates remote vehicles from authoritative snapshots.

## Goals

- W/A/S/D affects the local vehicle on the same rendered frame.
- Normal driving at realistic Internet RTT does not produce periodic rollback/correction hitches.
- Node remains the sole authority for vehicle state, collisions, spawn/despawn, and final outcomes.
- Keep 60 Hz simulation and 20 Hz STATE broadcast; do not increase network snapshot rate merely to hide timeline bugs.
- Preserve the existing binary protocol-v2 frame layout where possible.
- Preserve deterministic Rapier configuration and all vehicle/collision tuning.
- Remote vehicles render smoothly from authoritative data without forcing local-owner rollback.
- Collision outcomes remain server-authoritative and converge identically on all clients.
- Full-sync/resume remains the recovery path for missing history, incompatible state, or large discontinuities.

## Non-goals

- Predict remote players from their private inputs.
- Client authority over collisions or vehicle state.
- Changing Rapier, map collision, wheel, suspension, engine, or mass tuning.
- Raising STATE broadcast from 20 Hz to 60 Hz.
- Adding speculative remote collision proxies in the first implementation. This can be evaluated later if authoritative collision response feels too delayed after the timeline fix.

## Chosen Architecture

### 1. Three timelines

The client explicitly maintains:

- `serverTickEstimate`: estimated current Node simulation tick.
- `predictedServerTick`: the tick the local owner prediction is currently simulating; intentionally ahead of `serverTickEstimate` by command lead/slack.
- `interpolationTick`: a delayed authoritative timeline used only for remote rendering.

The server continues to own one monotonic 60 Hz simulation timeline.

### 2. TickSynchronizer

Add `sources/Game/MultiplayerV2/TickSynchronizer.js`.

Inputs:

- latest received `STATE.serverTick` and local monotonic receive time;
- input send timestamps by sequence;
- sequence acknowledgements (`lastConfirmedSequence`) from local authoritative state;
- known 60 Hz simulation rate and 20 Hz state cadence.

Outputs:

- estimated current server tick;
- desired predicted tick;
- adaptive command lead in ticks;
- interpolation target tick.

Initial command lead is conservative so the first commands are queued ahead rather than arriving late. Thereafter the synchronizer maintains an EWMA of acknowledgement RTT and jitter. The desired lead is based on approximately half RTT plus jitter margin and fixed command slack, clamped to a bounded range. If an acknowledgement proves that a command was processed materially later than its expected server application tick, lead increases immediately; it decreases only slowly after a stable period.

The synchronizer must never teleport the local prediction clock to chase small timing drift. `AuthoritativeMultiplayer.update()` may catch up by the existing bounded number of fixed ticks or briefly stop advancing when it is ahead. Large clock discontinuities request full sync.

### 3. Preserve the existing wire layout

Do not bump protocol-v2 solely for this change.

The existing 32-bit `input.clientTick` field remains on the wire, but its client-side meaning becomes the server input timeline tick, not the browser's independent local tick.

The server currently consumes:

`inputTick = serverSimulationTick - INPUT_BUFFER_TICKS`

with `INPUT_BUFFER_TICKS = 3`.

Therefore, when the client predicts physical simulation tick `P`, the command used for that step is serialized with:

`commandTick = P - INPUT_BUFFER_TICKS`

The local history records both values explicitly:

- `predictionTick`: physical tick simulated locally;
- `input.clientTick`: serialized command tick consumed by the existing server buffer.

This keeps the current binary codec and server's three-tick deterministic buffer while aligning which command is applied on which physical simulation tick.

### 4. InputPublisher changes

`InputPublisher.sample()` changes from `sample(localTick)` to `sample(predictionTick)`.

For each sample it:

1. computes `commandTick = predictionTick - 3`;
2. captures/quantizes player input immediately;
3. records `{ entityOrder, predictionTick, input }` in reconciliation history;
4. serializes `commandTick` into the existing `input.clientTick` field;
5. tracks `sentAt` for each sequence when the containing batch is successfully sent.

Batching remains at three simulation samples / maximum six records unless tests prove it creates avoidable command lateness. Batching is not changed as the first lever.

### 5. Server late-input behavior becomes a safety path

The current late-input coalescing remains available as a fail-safe, but correct steady-state operation must make it exceptional rather than continuous.

The server continues counting late inputs. New diagnostics distinguish:

- intentionally queued future commands;
- stale/late commands;
- persistent unconsumed backlog.

The old expectation that raw queue depth must always be zero is no longer a valid health criterion once clients intentionally send commands ahead. The gate becomes: future lead is bounded, stale backlog is zero, and queued commands never grow beyond the configured lead window.

No gate is removed without a replacement bound.

### 6. Local-owner prediction only

The local owner's vehicle is the only vehicle whose gameplay motion is predicted from immediate local input.

Remote vehicles are not used as a reason to rollback the local owner. Their authoritative STATE samples feed render-only snapshot buffers.

For the first implementation, local PredictionWorld should not depend on unknown live remote inputs. The simplest acceptable model is local vehicle + authoritative map/static collision. Vehicle-to-vehicle collision remains decided by the Node simulation. When a server collision materially changes the local owner's state, local reconciliation applies that authoritative result and replays unacknowledged local commands.

A future kinematic remote collision proxy is explicitly out of scope until the base owner-predicted path is smooth and measured.

### 7. Remote interpolation

Add one bounded snapshot buffer per remote entity in `VehicleVisuals` or a dedicated `RemoteSnapshotBuffer`.

Each authoritative STATE inserts remote position, quaternion, linear/angular velocity, wheel/contact/controller visual fields, and server tick.

Rendering uses an `interpolationTick` behind the latest estimated server time. The initial interpolation delay is based on at least two 20 Hz STATE intervals and is adjusted slowly from observed jitter. Normal rendering interpolates only between already received states. Very short bounded extrapolation is allowed only when the next sample is missing; otherwise hold the latest state.

Remote interpolation never mutates PredictionWorld and never triggers local-owner reconciliation.

### 8. Local reconciliation is entity-scoped

Stop using whole-world `checksum32` as the normal 20 Hz rollback trigger for the local owner.

For every authoritative STATE, `Reconciler`:

1. acknowledges local input sequences;
2. finds the predicted local-owner state recorded at `serverTick`;
3. compares local position, rotation, linear velocity, and angular velocity against the authoritative local state;
4. ignores tiny error inside strict tolerances;
5. performs rollback/replay only when local error exceeds the soft threshold;
6. snaps or requests full sync only for hard discontinuity / missing history / incompatible topology.

The whole-world hash/checksum is retained for diagnostics, deterministic benchmark evidence, and hard-sync integrity checks. It does not force owner rollback merely because a remote vehicle differs.

Initial thresholds are constants covered by tests and tuned from measured public traces, not visual guesswork. Proposed starting bounds:

- soft position error: 0.05 m;
- soft rotation error: 1 degree;
- soft linear velocity error: 0.25 m/s;
- soft angular velocity error: 0.10 rad/s;
- hard visual snap distance remains 3 m;
- hard visual snap angle remains 90 degrees.

The final numerical values may only be changed with recorded test/trace evidence.

### 9. Replay uses predictionTick, not wire clientTick

`InputHistory` records local prediction metadata so rollback replay is keyed by the physical `predictionTick` that was actually simulated.

This removes the current ambiguity where `input.clientTick` is used both as a network command label and as the local physical replay tick.

On rollback from authoritative server tick `S` to current predicted tick `P`, the client replays `S+1 ... P` using the exact local input recorded for each `predictionTick`. Acknowledged sequences are pruned; newer sequences remain.

### 10. Visual correction becomes exceptional

`VisualCorrection` remains, but it is no longer expected to hide a correction every 50 ms.

- no local error: no correction;
- tiny error: ignore;
- soft rollback error: preserve current rendered pose and decay the error offset;
- hard collision/teleport/full-sync discontinuity: fast correction or snap according to existing hard thresholds.

A successful steady-state drive should show zero periodic correction cadence.

## Data Flow

### Local owner

`keyboard/gamepad -> sample immediate input -> predictionTick P -> commandTick P-3 -> local PredictionWorld step -> batch command -> Node queue -> Node physical tick P -> STATE@P -> local error check -> normally confirm only`

### Remote player

`Node physical simulation -> STATE@S -> remote snapshot buffer -> interpolationTick < serverTickEstimate -> render interpolation`

### Collision

`Node detects authoritative vehicle collision -> STATE contains changed local/remote states -> local owner reconciles only if its own state materially differs -> remote vehicles continue from authoritative interpolation buffer -> all clients converge on Node outcome`

## Deployment Safety

Because the binary frame layout remains protocol-v2 compatible and the server's three-tick input buffer remains present, the change can be staged without an atomic protocol-version cutover.

Recommended order:

1. deploy server diagnostics / bounded future-queue gates that remain compatible with current clients;
2. deploy the new Pages client prediction timeline;
3. observe public driving metrics and late-input counts;
4. keep `VITE_MULTIPLAYER_PROTOCOL=1` as the existing emergency rollback path until the new driving gate is green.

Do not remove the current late-input safety path during the initial rollout.

## TDD / Verification Plan

### A. Tick synchronization unit tests

- server tick estimate advances at 60 Hz between STATE frames;
- RTT/jitter increases command lead within a fixed upper bound;
- stable low RTT decreases lead slowly, never oscillating every packet;
- future/past discontinuity beyond the recovery window requests full sync;
- 32-bit tick wrap remains correct.

### B. Command mapping tests

For prediction tick `P`, verify serialized `input.clientTick === P - 3` and replay metadata keeps `predictionTick === P`.

Verify the existing Node `RoomSimulation` consumes that command on physical server tick `P` without late coalescing.

### C. Network simulation regression

Run deterministic simulated networks at at least:

- RTT 20 ms;
- RTT 60 ms;
- RTT 100 ms;
- RTT 150 ms;
- jitter 0/10/30 ms;
- packet reordering and bounded drops already represented by current network fixtures.

Scenarios:

- 10 s sustained throttle;
- sustained steering;
- brake/reverse transition;
- stop/start input changes;
- two-client head-on collision;
- reconnect during/after motion.

Required normal-driving outcome:

- immediate local input response;
- no periodic 20 Hz visual hitch;
- late-input ratio near zero after synchronizer convergence;
- no unbounded future command queue;
- local rollback rate near zero when there is no collision/topology change;
- final authority convergence remains exact.

### D. Remote interpolation tests

- remote snapshot insertion is ordered and bounded;
- 20 Hz samples render smooth 60+ Hz motion at the interpolation timeline;
- jitter does not cause reverse time / visible snap;
- remote interpolation never mutates PredictionWorld;
- entity spawn/despawn clears only that entity's snapshot buffer.

### E. Reconciliation tests

- remote-only state change does not rollback the local owner;
- local error under soft thresholds confirms without rollback;
- local error over soft threshold rolls back and replays by `predictionTick`;
- collision-sized error applies authoritative local state and converges;
- missing rollback history requests full sync;
- whole-world hash mismatch remains observable but is not a normal local-owner rollback trigger unless accompanied by integrity/full-sync criteria.

### F. Public driving gate

After CI is green, run two geographically separated browsers against the production-like Node endpoint.

Collect at least:

- observed RTT/jitter;
- command lead ticks;
- late-input count/rate;
- local rollback count/rate;
- hard-sync count;
- correction distance/angle distribution;
- remote interpolation buffer depth;
- disconnect/backlog/divergence existing metrics.

Acceptance:

- local input response is same-frame;
- sustained normal driving has no recurring hitch cadence;
- no persistent backlog;
- no unbounded command lead;
- no periodic rollback in collision-free driving;
- both clients converge on the same authoritative collision outcome;
- existing 8-client/600 s performance hard gates remain green under the revised bounded-future-queue semantics.

## Rollback

Production rollback remains `VITE_MULTIPLAYER_PROTOCOL=1` plus Pages rebuild.

Within protocol-v2, implementation will be split into small commits so TickSynchronizer, local reconciliation, and remote interpolation can be reverted independently before final cutover.

## Design Decisions / Trade-offs

### Why not increase STATE to 60 Hz?

It increases bandwidth and server send work but does not fix a mismatched command timeline. Keep 20 Hz network snapshots and 60 Hz simulation.

### Why not keep smoothing every rollback?

Smoothing masks visible discontinuity but still leaves repeated rollback/replay CPU cost and control feel. The goal is to make normal snapshots confirm prediction rather than correct it.

### Why owner prediction instead of predicting all vehicles?

The client has immediate local input but not every remote player's live command stream. Predicting remote dynamic vehicles from missing/stale commands creates avoidable whole-world divergence. Remote interpolation is deterministic from received snapshots and isolates remote jitter from local controls.

### Why preserve the three-tick server input buffer?

It is already part of the validated deterministic server timeline and provides a small jitter cushion. Align the client's command label to that timeline instead of deleting the buffer and changing collision timing at the same time.

## External Design Basis

This design follows the established server-authoritative prediction model where a client predicts ahead of the server by command slack, sends tick-associated commands before the server reaches that tick, rolls back/replays from authoritative snapshots when required, and uses owner prediction for the local player while interpolating non-owned entities. The repository implementation remains custom and does not add Unity or another networking runtime dependency.
