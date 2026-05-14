/**
 * Tiered polling loop.
 *
 * Three tiers run on independent intervals (mirrors tautulli-exporter):
 *
 *   fast (default 15s)  – server health, containers, open alerts. Drives
 *                         `komodo_up`.
 *   slow (default 5m)   – inventory: stacks, deployments, builds, repos,
 *                         procedures, syncs.
 *   meta (default 30m)  – core version + title.
 *
 * Each tier records its own duration / failure counter / last-success
 * timestamp, so a slow-tier blip never flips the up/down signal.
 */

import type { Logger } from "pino";

import type { ApiClient } from "./client.js";
import { Types } from "./client.js";
import type { Config } from "./config.js";
import type { Metrics, Tier } from "./metrics.js";
import { serverStateValue } from "./metrics.js";

interface Step {
  name: string;
  fn: () => Promise<void>;
}

/**
 * Internal: thrown by poll runners with the failing step name attached so
 * we can label `komodo_exporter_poll_failures_total` consistently.
 */
class StepFailure extends Error {
  constructor(
    readonly step: string,
    readonly cause: unknown,
  ) {
    super(`poll step '${step}' failed: ${describe(cause)}`);
    this.name = "StepFailure";
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err !== null && typeof err === "object") {
    try {
      return JSON.stringify(err);
    } catch {
      return "[unserializable object]";
    }
  }
  if (typeof err === "string") return err;
  if (typeof err === "number" || typeof err === "boolean") return String(err);
  return "[unknown]";
}

export class Poller {
  private readonly stops = new Set<() => void>();
  private fastConsecutiveFailures = 0;
  private fastHasSucceeded = false;

  constructor(
    private readonly client: ApiClient,
    private readonly metrics: Metrics,
    private readonly config: Config,
    private readonly log: Logger,
  ) {}

  /** Start all three tiers. Returns a stop function that resolves when loops exit. */
  start(): () => Promise<void> {
    this.log.info(
      {
        fast: this.config.fastPollInterval,
        slow: this.config.slowPollInterval,
        meta: this.config.metaPollInterval,
      },
      "starting poll loops",
    );

    const fastStop = this.spawn("fast", this.config.fastPollInterval, [
      { name: "servers", fn: () => this.pollServers() },
      { name: "containers", fn: () => this.pollContainers() },
      { name: "alerts", fn: () => this.pollAlerts() },
    ]);
    const slowStop = this.spawn("slow", this.config.slowPollInterval, [
      { name: "stacks", fn: () => this.pollStacks() },
      { name: "deployments", fn: () => this.pollDeployments() },
      { name: "builds", fn: () => this.pollBuilds() },
      { name: "repos", fn: () => this.pollRepos() },
      { name: "procedures", fn: () => this.pollProcedures() },
      { name: "syncs", fn: () => this.pollSyncs() },
    ]);
    const metaStop = this.spawn("meta", this.config.metaPollInterval, [
      { name: "version", fn: () => this.pollVersion() },
    ]);

    return async () => {
      await Promise.all([fastStop(), slowStop(), metaStop()]);
    };
  }

  private spawn(tier: Tier, intervalSec: number, steps: Step[]): () => Promise<void> {
    let stopped = false;
    let stopResolve: (() => void) | null = null;
    let pendingSleep: NodeJS.Timeout | null = null;
    let wakeUp: (() => void) | null = null;

    const stoppedPromise = new Promise<void>((resolve) => {
      stopResolve = resolve;
    });

    const stop = () => {
      stopped = true;
      if (pendingSleep) clearTimeout(pendingSleep);
      wakeUp?.();
    };
    this.stops.add(stop);

    const loop = async () => {
      while (!stopped) {
        await this.runTier(tier, steps);
        // `stopped` is mutated by the `stop` closure from outside the loop;
        // typescript-eslint can't see across that boundary so it flags the
        // check as constant.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (stopped) break;
        await new Promise<void>((resolve) => {
          wakeUp = resolve;
          pendingSleep = setTimeout(resolve, intervalSec * 1000);
        });
        wakeUp = null;
        pendingSleep = null;
      }
      stopResolve?.();
    };

    void loop();

    return () => {
      stop();
      return stoppedPromise;
    };
  }

  /** Stop all loops. Safe to call multiple times. */
  stop(): void {
    const stops = Array.from(this.stops);
    this.stops.clear();
    for (const s of stops) s();
  }

  // ---- tier orchestration --------------------------------------------------

  private async runTier(tier: Tier, steps: Step[]): Promise<void> {
    const started = performance.now();
    let firstFailure: StepFailure | null = null;

    for (const step of steps) {
      try {
        await step.fn();
      } catch (cause) {
        const failure = new StepFailure(step.name, cause);
        firstFailure ??= failure;
        this.metrics.pollFailures.labels({ tier, step: step.name }).inc();
        this.log.error(
          { tier, step: step.name, err: describe(cause) },
          "poll step failed",
        );
      }
    }

    const durationSec = (performance.now() - started) / 1000;
    this.metrics.pollDuration.labels({ tier }).set(durationSec);

    if (tier === "fast") {
      if (firstFailure) {
        this.metrics.up.set(0);
        this.fastConsecutiveFailures += 1;
      } else {
        this.metrics.up.set(1);
        this.metrics.lastSuccessfulPoll
          .labels({ tier })
          .set(Date.now() / 1000);
        if (!this.fastHasSucceeded) {
          this.fastHasSucceeded = true;
          this.log.info({ durationSec }, "first successful fast poll");
        } else if (this.fastConsecutiveFailures > 0) {
          this.log.info(
            { durationSec, recoveredAfter: this.fastConsecutiveFailures },
            "fast poll recovered",
          );
        }
        this.fastConsecutiveFailures = 0;
      }
    } else if (!firstFailure) {
      this.metrics.lastSuccessfulPoll.labels({ tier }).set(Date.now() / 1000);
    }
  }

  // ---- fast tier -----------------------------------------------------------

  private async pollServers(): Promise<void> {
    const [summary, servers] = await Promise.all([
      this.client.read("GetServersSummary", {}),
      this.client.read("ListServers", { query: undefined }),
    ]);

    this.metrics.serversTotal.set(summary.total);
    this.metrics.serversByState.reset();
    this.metrics.serversByState.labels({ state: "healthy" }).set(summary.healthy);
    this.metrics.serversByState.labels({ state: "unhealthy" }).set(summary.unhealthy);
    this.metrics.serversByState.labels({ state: "disabled" }).set(summary.disabled);
    this.metrics.serversByState.labels({ state: "warning" }).set(summary.warning);

    this.metrics.serverState.reset();
    for (const server of servers) {
      this.metrics.serverState
        .labels({ name: server.name, region: server.info.region })
        .set(serverStateValue(server.info.state));
    }
  }

  private async pollContainers(): Promise<void> {
    const containers = await this.client.read("ListAllDockerContainers", {});

    this.metrics.containerState.reset();
    this.metrics.containerCreated.reset();

    for (const container of containers) {
      const labels = {
        server_id: container.server_id ?? "",
        container: container.name,
        image: container.image ?? "",
      };
      this.metrics.containerState
        .labels({ ...labels, state: stringifyContainerState(container.state) })
        .set(1);

      if (container.created !== undefined) {
        this.metrics.containerCreated.labels(labels).set(container.created);
      }
    }
  }

  private async pollAlerts(): Promise<void> {
    // Komodo's mongo-style query: only resolved=false alerts. No paging
    // needed for active alerts in practice (a healthy system has < 100).
    // `MongoDocument` is typed as `any` upstream; the suppressions here are
    // confined to the single line that introduces the unsafe value so the
    // rest of the file stays under the strict-type-checked defaults.
    /* eslint-disable @typescript-eslint/no-unsafe-assignment */
    const query: Types.MongoDocument = { resolved: false };
    const response = await this.client.read("ListAlerts", { query });
    /* eslint-enable @typescript-eslint/no-unsafe-assignment */

    const counts = new Map<string, number>();
    for (const alert of response.alerts) {
      const key = `${alert.level}|${alert.data.type}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    this.metrics.openAlerts.reset();
    // Pre-seed known severities so the gauge always exists for alerting.
    for (const level of [
      Types.SeverityLevel.Ok,
      Types.SeverityLevel.Warning,
      Types.SeverityLevel.Critical,
    ]) {
      this.metrics.openAlerts.labels({ level, type: "" }).set(0);
    }
    for (const [key, value] of counts) {
      const [level, type] = key.split("|", 2) as [string, string];
      this.metrics.openAlerts.labels({ level, type }).set(value);
    }
  }

  // ---- slow tier -----------------------------------------------------------

  private async pollStacks(): Promise<void> {
    const [summary, stacks] = await Promise.all([
      this.client.read("GetStacksSummary", {}),
      this.client.read("ListStacks", { query: undefined }),
    ]);

    this.metrics.stacksTotal.set(summary.total);
    this.metrics.stacksByState.reset();
    this.metrics.stacksByState.labels({ state: "running" }).set(summary.running);
    this.metrics.stacksByState.labels({ state: "stopped" }).set(summary.stopped);
    this.metrics.stacksByState.labels({ state: "down" }).set(summary.down);
    this.metrics.stacksByState.labels({ state: "unhealthy" }).set(summary.unhealthy);
    this.metrics.stacksByState.labels({ state: "unknown" }).set(summary.unknown);

    this.metrics.stackState.reset();
    for (const stack of stacks) {
      this.metrics.stackState
        .labels({
          name: stack.name,
          server_id: stack.info.server_id,
          state: stack.info.state,
        })
        .set(1);
    }
  }

  private async pollDeployments(): Promise<void> {
    const [summary, deployments] = await Promise.all([
      this.client.read("GetDeploymentsSummary", {}),
      this.client.read("ListDeployments", { query: undefined }),
    ]);

    this.metrics.deploymentsTotal.set(summary.total);
    this.metrics.deploymentsByState.reset();
    this.metrics.deploymentsByState.labels({ state: "running" }).set(summary.running);
    this.metrics.deploymentsByState.labels({ state: "stopped" }).set(summary.stopped);
    this.metrics.deploymentsByState
      .labels({ state: "not_deployed" })
      .set(summary.not_deployed);
    this.metrics.deploymentsByState.labels({ state: "unhealthy" }).set(summary.unhealthy);
    this.metrics.deploymentsByState.labels({ state: "unknown" }).set(summary.unknown);

    this.metrics.deploymentState.reset();
    this.metrics.deploymentUpdateAvailable.reset();
    for (const deployment of deployments) {
      const labels = {
        name: deployment.name,
        server_id: deployment.info.server_id,
        image: deployment.info.image,
      };
      this.metrics.deploymentState
        .labels({ ...labels, state: deployment.info.state })
        .set(1);
      this.metrics.deploymentUpdateAvailable
        .labels(labels)
        .set(deployment.info.update_available ? 1 : 0);
    }
  }

  private async pollBuilds(): Promise<void> {
    const [summary, builds] = await Promise.all([
      this.client.read("GetBuildsSummary", {}),
      this.client.read("ListBuilds", { query: undefined }),
    ]);

    this.metrics.buildsTotal.set(summary.total);
    this.metrics.buildsByState.reset();
    this.metrics.buildsByState.labels({ state: "ok" }).set(summary.ok);
    this.metrics.buildsByState.labels({ state: "failed" }).set(summary.failed);
    this.metrics.buildsByState.labels({ state: "building" }).set(summary.building);
    this.metrics.buildsByState.labels({ state: "unknown" }).set(summary.unknown);

    this.metrics.buildLastBuilt.reset();
    for (const build of builds) {
      if (build.info.last_built_at && build.info.last_built_at > 0) {
        this.metrics.buildLastBuilt
          .labels({ name: build.name })
          .set(build.info.last_built_at / 1000);
      }
    }
  }

  private async pollRepos(): Promise<void> {
    const summary = await this.client.read("GetReposSummary", {});

    this.metrics.reposTotal.set(summary.total);
    this.metrics.reposByState.reset();
    this.metrics.reposByState.labels({ state: "ok" }).set(summary.ok);
    this.metrics.reposByState.labels({ state: "cloning" }).set(summary.cloning);
    this.metrics.reposByState.labels({ state: "pulling" }).set(summary.pulling);
    this.metrics.reposByState.labels({ state: "building" }).set(summary.building);
    this.metrics.reposByState.labels({ state: "failed" }).set(summary.failed);
    this.metrics.reposByState.labels({ state: "unknown" }).set(summary.unknown);
  }

  private async pollProcedures(): Promise<void> {
    const [summary, procedures] = await Promise.all([
      this.client.read("GetProceduresSummary", {}),
      this.client.read("ListProcedures", { query: undefined }),
    ]);

    this.metrics.proceduresTotal.set(summary.total);
    this.metrics.proceduresByState.reset();
    this.metrics.proceduresByState.labels({ state: "ok" }).set(summary.ok);
    this.metrics.proceduresByState.labels({ state: "running" }).set(summary.running);
    this.metrics.proceduresByState.labels({ state: "failed" }).set(summary.failed);
    this.metrics.proceduresByState.labels({ state: "unknown" }).set(summary.unknown);

    this.metrics.procedureLastRun.reset();
    for (const procedure of procedures) {
      if (procedure.info.last_run_at && procedure.info.last_run_at > 0) {
        this.metrics.procedureLastRun
          .labels({ name: procedure.name })
          .set(procedure.info.last_run_at / 1000);
      }
    }
  }

  private async pollSyncs(): Promise<void> {
    const syncs = await this.client.read("ListResourceSyncs", { query: undefined });

    const counts = new Map<string, number>();
    for (const sync of syncs) {
      counts.set(sync.info.state, (counts.get(sync.info.state) ?? 0) + 1);
    }

    this.metrics.syncsTotal.set(syncs.length);
    this.metrics.syncsByState.reset();
    for (const state of Object.values(Types.ResourceSyncState)) {
      this.metrics.syncsByState
        .labels({ state })
        .set(counts.get(state) ?? 0);
    }
  }

  // ---- meta tier -----------------------------------------------------------

  private async pollVersion(): Promise<void> {
    const [version, info] = await Promise.all([
      this.client.read("GetVersion", {}),
      this.client.read("GetCoreInfo", {}),
    ]);
    this.metrics.coreVersion.reset();
    this.metrics.coreVersion
      .labels({ version: version.version, title: info.title })
      .set(1);
  }
}

function stringifyContainerState(state: Types.ContainerStateStatusEnum): string {
  // The enum value for `Empty` is "" — turn that into something human-readable
  // so Prometheus doesn't silently drop the label series.
  return state === Types.ContainerStateStatusEnum.Empty ? "unknown" : state;
}
