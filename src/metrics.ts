/**
 * Prometheus metric definitions.
 *
 * All metrics live in one place so the README table and the source stay in
 * sync. The container is bound to an explicit `Registry` instance so tests
 * can use a fresh registry per test (matching the Python pattern).
 */

import {
  Counter,
  Gauge,
  type Registry,
  type CounterConfiguration,
  type GaugeConfiguration,
} from "prom-client";

import { Types } from "./client.js";

export type Tier = "fast" | "slow" | "meta";

/** Encodes a server's health as a gauge value: 1=Ok, 0=Disabled, -1=NotOk. */
export function serverStateValue(state: Types.ServerState): number {
  switch (state) {
    case Types.ServerState.Ok:
      return 1;
    case Types.ServerState.Disabled:
      return 0;
    case Types.ServerState.NotOk:
      return -1;
  }
}

export class Metrics {
  readonly registry: Registry;

  // ---- summary gauges ----
  readonly serversTotal: Gauge;
  readonly serversByState: Gauge<"state">;
  readonly serverState: Gauge<"name" | "region">;

  readonly stacksTotal: Gauge;
  readonly stacksByState: Gauge<"state">;
  readonly stackState: Gauge<"name" | "server_id" | "state">;

  readonly deploymentsTotal: Gauge;
  readonly deploymentsByState: Gauge<"state">;
  readonly deploymentState: Gauge<
    "name" | "server_id" | "image" | "state"
  >;
  readonly deploymentUpdateAvailable: Gauge<
    "name" | "server_id" | "image"
  >;

  readonly buildsTotal: Gauge;
  readonly buildsByState: Gauge<"state">;
  readonly buildLastBuilt: Gauge<"name">;

  readonly reposTotal: Gauge;
  readonly reposByState: Gauge<"state">;

  readonly proceduresTotal: Gauge;
  readonly proceduresByState: Gauge<"state">;
  readonly procedureLastRun: Gauge<"name">;

  readonly syncsTotal: Gauge;
  readonly syncsByState: Gauge<"state">;

  readonly openAlerts: Gauge<"level" | "type">;

  // ---- container metrics (per-container) ----
  readonly containerState: Gauge<
    "server_id" | "container" | "image" | "state"
  >;
  readonly containerCreated: Gauge<"server_id" | "container" | "image">;

  // ---- meta ----
  readonly coreVersion: Gauge<"version" | "title">;
  readonly up: Gauge;

  // ---- self-monitoring ----
  readonly pollDuration: Gauge<"tier">;
  readonly pollFailures: Counter<"tier" | "step">;
  readonly lastSuccessfulPoll: Gauge<"tier">;

  constructor(registry: Registry) {
    this.registry = registry;

    const gauge = <T extends string>(c: GaugeConfiguration<T>): Gauge<T> =>
      new Gauge({ ...c, registers: [registry] });
    const counter = <T extends string>(c: CounterConfiguration<T>): Counter<T> =>
      new Counter({ ...c, registers: [registry] });

    this.serversTotal = gauge({
      name: "komodo_servers_total",
      help: "Total number of servers known to Komodo",
    });
    this.serversByState = gauge({
      name: "komodo_servers_by_state",
      help: "Servers grouped by health (healthy/unhealthy/disabled/warning)",
      labelNames: ["state"] as const,
    });
    this.serverState = gauge({
      name: "komodo_server_state",
      help: "Per-server state. Value: 1=Ok, 0=Disabled, -1=NotOk",
      labelNames: ["name", "region"] as const,
    });

    this.stacksTotal = gauge({
      name: "komodo_stacks_total",
      help: "Total number of stacks",
    });
    this.stacksByState = gauge({
      name: "komodo_stacks_by_state",
      help: "Stacks grouped by aggregate state",
      labelNames: ["state"] as const,
    });
    this.stackState = gauge({
      name: "komodo_stack_state",
      help: "Per-stack state. Value 1 means the stack is currently in this state.",
      labelNames: ["name", "server_id", "state"] as const,
    });

    this.deploymentsTotal = gauge({
      name: "komodo_deployments_total",
      help: "Total number of deployments",
    });
    this.deploymentsByState = gauge({
      name: "komodo_deployments_by_state",
      help: "Deployments grouped by state",
      labelNames: ["state"] as const,
    });
    this.deploymentState = gauge({
      name: "komodo_deployment_state",
      help: "Per-deployment state. Value 1 means the deployment is currently in this state.",
      labelNames: ["name", "server_id", "image", "state"] as const,
    });
    this.deploymentUpdateAvailable = gauge({
      name: "komodo_deployment_update_available",
      help: "1 if a newer image is available at the same tag for this deployment",
      labelNames: ["name", "server_id", "image"] as const,
    });

    this.buildsTotal = gauge({
      name: "komodo_builds_total",
      help: "Total number of builds",
    });
    this.buildsByState = gauge({
      name: "komodo_builds_by_state",
      help: "Builds grouped by state",
      labelNames: ["state"] as const,
    });
    this.buildLastBuilt = gauge({
      name: "komodo_build_last_built_timestamp_seconds",
      help: "Unix timestamp (seconds) of the last build for each build resource",
      labelNames: ["name"] as const,
    });

    this.reposTotal = gauge({
      name: "komodo_repos_total",
      help: "Total number of repos",
    });
    this.reposByState = gauge({
      name: "komodo_repos_by_state",
      help: "Repos grouped by state",
      labelNames: ["state"] as const,
    });

    this.proceduresTotal = gauge({
      name: "komodo_procedures_total",
      help: "Total number of procedures",
    });
    this.proceduresByState = gauge({
      name: "komodo_procedures_by_state",
      help: "Procedures grouped by state",
      labelNames: ["state"] as const,
    });
    this.procedureLastRun = gauge({
      name: "komodo_procedure_last_run_timestamp_seconds",
      help: "Unix timestamp (seconds) of the last successful procedure run",
      labelNames: ["name"] as const,
    });

    this.syncsTotal = gauge({
      name: "komodo_syncs_total",
      help: "Total number of resource syncs",
    });
    this.syncsByState = gauge({
      name: "komodo_syncs_by_state",
      help: "Resource syncs grouped by state",
      labelNames: ["state"] as const,
    });

    this.openAlerts = gauge({
      name: "komodo_open_alerts",
      help: "Open (unresolved) Komodo alerts grouped by severity and type",
      labelNames: ["level", "type"] as const,
    });

    this.containerState = gauge({
      name: "komodo_container_state",
      help: "Per-container state on each Komodo server. Value 1 means the container is currently in this state.",
      labelNames: ["server_id", "container", "image", "state"] as const,
    });
    this.containerCreated = gauge({
      name: "komodo_container_created_timestamp_seconds",
      help:
        "Unix timestamp (seconds) when each container was created. " +
        "PromQL: time() - komodo_container_created_timestamp_seconds for uptime.",
      labelNames: ["server_id", "container", "image"] as const,
    });

    this.coreVersion = gauge({
      name: "komodo_core_version_info",
      help: "Komodo Core version (always 1; carries version + title labels)",
      labelNames: ["version", "title"] as const,
    });
    this.up = gauge({
      name: "komodo_up",
      help: "1 if the exporter can reach Komodo (driven by the fast tier)",
    });

    this.pollDuration = gauge({
      name: "komodo_exporter_poll_duration_seconds",
      help: "Wall-clock duration of the most recent poll for each tier",
      labelNames: ["tier"] as const,
    });
    this.pollFailures = counter({
      name: "komodo_exporter_poll_failures_total",
      help: "Poll steps that ended in failure, labelled by tier and step",
      labelNames: ["tier", "step"] as const,
    });
    this.lastSuccessfulPoll = gauge({
      name: "komodo_exporter_last_successful_poll_timestamp_seconds",
      help: "Unix timestamp (seconds) of the most recent successful poll for each tier",
      labelNames: ["tier"] as const,
    });
  }
}
