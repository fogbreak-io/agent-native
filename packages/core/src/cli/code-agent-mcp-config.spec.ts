import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadMcpConfig, type McpConfig } from "../mcp-client/config.js";
import {
  claudeMcpConfig,
  codeAgentMcpConfigurationErrors,
  codexMcpChildEnv,
  codexMcpConfigArgs,
  mergeCodeAgentMcpConfig,
  restrictCodeAgentMcpConfig,
} from "./code-agent-mcp-config.js";
import type { CodeAgentPermissionMode } from "./code-agent-runs.js";

describe("code-agent MCP config", () => {
  it("accepts the full MCP_SERVERS shape", () => {
    const environment = {
      MCP_SERVERS: JSON.stringify({
        servers: {
          fullHttp: {
            type: "http",
            url: "https://full.example/mcp",
          },
          fullStdio: {
            command: "full-bin",
            args: ["--serve"],
          },
        },
      }),
    } as NodeJS.ProcessEnv;

    expect(mergeCodeAgentMcpConfig({ servers: {} }, environment)).toMatchObject(
      {
        source: "env:MCP_SERVERS",
        servers: {
          fullHttp: {
            type: "http",
            url: "https://full.example/mcp",
          },
          fullStdio: {
            command: "full-bin",
            args: ["--serve"],
          },
        },
      },
    );
    expect(codexMcpConfigArgs(null, environment)).toEqual([
      "-c",
      'mcp_servers.fullHttp.url="https://full.example/mcp"',
    ]);
  });

  it("accepts the inner-map MCP_SERVERS shape", () => {
    const environment = {
      MCP_SERVERS: JSON.stringify({
        innerHttp: {
          type: "http",
          url: "https://inner.example/mcp",
        },
        innerStdio: {
          command: "inner-bin",
        },
      }),
    } as NodeJS.ProcessEnv;

    expect(mergeCodeAgentMcpConfig({ servers: {} }, environment)).toMatchObject(
      {
        source: "env:MCP_SERVERS",
        servers: {
          innerHttp: {
            type: "http",
            url: "https://inner.example/mcp",
          },
          innerStdio: {
            command: "inner-bin",
          },
        },
      },
    );
    expect(codexMcpConfigArgs(null, environment)).toEqual([
      "-c",
      'mcp_servers.innerHttp.url="https://inner.example/mcp"',
    ]);
  });

  it("keeps only the exact allowlisted desktop server ids", () => {
    const config: McpConfig = {
      source: "desktop",
      servers: {
        allowed: {
          command: "allowed-bin",
        },
        "org_org-1_zapier": {
          type: "http",
          url: "https://zapier.example/mcp",
        },
      },
    };

    expect(
      restrictCodeAgentMcpConfig(config, {
        AGENT_NATIVE_CODE_AGENT_MCP_SERVER_ALLOWLIST: "allowed",
      }),
    ).toEqual({
      source: "desktop",
      servers: {
        allowed: {
          command: "allowed-bin",
        },
      },
    });
  });

  it("delivers the authenticated desktop server to both code-agent paths", () => {
    const token = "x".repeat(43);
    const environment = {
      MCP_SERVERS: JSON.stringify({
        servers: {
          workspace: {
            type: "http",
            url: "https://workspace.example/mcp",
          },
        },
      }),
      AGENT_NATIVE_CODE_AGENT_MCP_SERVER_ALLOWLIST: "workspace",
      AGENT_NATIVE_DESKTOP_CHILD: "1",
      AGENT_NATIVE_DESKTOP_COMPUTER_MCP_URL: "http://127.0.0.1:43123/mcp",
      AGENT_NATIVE_DESKTOP_COMPUTER_MCP_TOKEN: token,
    } as NodeJS.ProcessEnv;

    const merged = mergeCodeAgentMcpConfig({ servers: {} }, environment);
    expect(restrictCodeAgentMcpConfig(merged, environment)?.servers).toEqual({
      workspace: {
        type: "http",
        url: "https://workspace.example/mcp",
      },
      "agent-native-desktop-computer": {
        type: "http",
        url: "http://127.0.0.1:43123/mcp",
        headers: { Authorization: `Bearer ${token}` },
        description:
          "Authenticated computer control for this Agent-Native desktop task",
      },
    });
    expect(codexMcpConfigArgs(null, environment)).toContain(
      `mcp_servers.agent-native-desktop-computer.http_headers={"Authorization"="Bearer ${token}"}`,
    );
    expect(claudeMcpConfig(null, environment)).toEqual({
      mcpServers: {
        workspace: { type: "http", url: "https://workspace.example/mcp" },
        "agent-native-desktop-computer": {
          type: "http",
          url: "http://127.0.0.1:43123/mcp",
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    });
  });

  it("excludes servers with configuration errors and exposes their failure", () => {
    const unavailable = new Error("Saved MCP headers could not be read.");
    const config: McpConfig = {
      servers: {
        healthy: {
          type: "http",
          url: "https://healthy.example/mcp",
          headers: { Authorization: "Bearer healthy-placeholder" },
        },
        unavailable: {
          type: "http",
          url: "https://unavailable.example/mcp",
          configurationError: unavailable,
        },
      },
    };

    expect(claudeMcpConfig(config, {})).toEqual({
      mcpServers: {
        healthy: {
          type: "http",
          url: "https://healthy.example/mcp",
          headers: { Authorization: "Bearer healthy-placeholder" },
        },
      },
    });
    expect(codexMcpConfigArgs(config, {})).toEqual([
      "-c",
      'mcp_servers.healthy.url="https://healthy.example/mcp"',
      "-c",
      'mcp_servers.healthy.http_headers={"Authorization"="Bearer healthy-placeholder"}',
    ]);
    expect(codeAgentMcpConfigurationErrors(config, {})).toEqual([
      {
        serverId: "unavailable",
        message: "Saved MCP headers could not be read.",
      },
    ]);
  });

  it("leaves workspace-connection servers out of CLI configs", () => {
    const config: McpConfig = {
      servers: {
        healthy: {
          type: "http",
          url: "https://healthy.example/mcp",
          headers: { Authorization: "Bearer healthy-placeholder" },
        },
        user_abc_hubspot: {
          type: "http",
          url: "https://mcp.hubspot.com",
          workspaceConnection: {
            provider: "hubspot",
            connectionId: "hubspot-alice",
            ownerEmail: "alice@example.com",
            orgId: null,
            appId: "crm",
          },
        },
      },
    };

    expect(Object.keys(claudeMcpConfig(config, {})?.mcpServers ?? {})).toEqual([
      "healthy",
    ]);
    expect(codexMcpConfigArgs(config, {}).join(" ")).not.toContain("hubspot");
  });

  it("delivers nothing to Claude when no HTTP server is scoped in", () => {
    const environment = {
      MCP_SERVERS: JSON.stringify({
        servers: { local: { command: "local-bin" } },
      }),
    } as NodeJS.ProcessEnv;

    expect(claudeMcpConfig(null, environment)).toBeNull();
    expect(claudeMcpConfig(null, {})).toBeNull();
  });

  it("omits MCP servers with unreadable saved configuration and reports them", () => {
    const config: McpConfig = {
      servers: {
        unavailable: {
          type: "http",
          url: "https://unavailable.example/mcp",
          configurationError: new Error("saved credential unavailable"),
        },
        available: {
          type: "http",
          url: "https://available.example/mcp",
          headers: { Authorization: "Bearer placeholder-token" },
        },
      },
    };

    expect(codeAgentMcpConfigurationErrors(config, {})).toEqual([
      {
        serverId: "unavailable",
        message: "saved credential unavailable",
      },
    ]);
    expect(claudeMcpConfig(config, {})).toEqual({
      mcpServers: {
        available: {
          type: "http",
          url: "https://available.example/mcp",
          headers: { Authorization: "Bearer placeholder-token" },
        },
      },
    });
    expect(codexMcpConfigArgs(config, {})).toEqual([
      "-c",
      'mcp_servers.available.url="https://available.example/mcp"',
      "-c",
      'mcp_servers.available.http_headers={"Authorization"="Bearer placeholder-token"}',
    ]);
  });

  it("rejects server ids that normalize to the same key", () => {
    const environment = {
      MCP_SERVERS: JSON.stringify({
        servers: {
          "sales.prod": { type: "http", url: "https://dot.example/mcp" },
          "sales/prod": {
            type: "http",
            url: "https://slash.example/mcp",
            headers: { Authorization: "Bearer placeholder-token" },
          },
        },
      }),
    } as NodeJS.ProcessEnv;
    const collision =
      'MCP server IDs "sales.prod" and "sales/prod" both map to "sales_prod"';

    expect(() => claudeMcpConfig(null, environment)).toThrow(collision);
    expect(() => codexMcpConfigArgs(null, environment)).toThrow(collision);
  });

  it("keeps distinct normalized keys for both code-agent paths", () => {
    const environment = {
      MCP_SERVERS: JSON.stringify({
        servers: {
          "sales.prod": { type: "http", url: "https://dot.example/mcp" },
          "sales-prod": { type: "http", url: "https://dash.example/mcp" },
        },
      }),
    } as NodeJS.ProcessEnv;

    expect(claudeMcpConfig(null, environment)).toEqual({
      mcpServers: {
        sales_prod: { type: "http", url: "https://dot.example/mcp" },
        "sales-prod": { type: "http", url: "https://dash.example/mcp" },
      },
    });
    expect(codexMcpConfigArgs(null, environment)).toEqual([
      "-c",
      'mcp_servers.sales_prod.url="https://dot.example/mcp"',
      "-c",
      'mcp_servers.sales-prod.url="https://dash.example/mcp"',
    ]);
  });

  it("resolves a desktop server collision consistently", () => {
    const environment = {
      MCP_SERVERS: JSON.stringify({
        servers: {
          "agent-native-desktop-computer": {
            type: "http",
            url: "https://user.example/mcp",
          },
        },
      }),
      AGENT_NATIVE_CODE_AGENT_MCP_SERVER_ALLOWLIST:
        "agent-native-desktop-computer",
      AGENT_NATIVE_DESKTOP_CHILD: "1",
      AGENT_NATIVE_DESKTOP_COMPUTER_MCP_URL: "http://127.0.0.1:43123/mcp",
      AGENT_NATIVE_DESKTOP_COMPUTER_MCP_TOKEN: "x".repeat(43),
    } as NodeJS.ProcessEnv;

    const merged = mergeCodeAgentMcpConfig({ servers: {} }, environment);
    expect(
      Object.keys(restrictCodeAgentMcpConfig(merged, environment)!.servers),
    ).toEqual([
      "agent-native-desktop-computer",
      "agent-native-desktop-computer-2",
    ]);
    expect(codexMcpConfigArgs(null, environment).join("\n")).toContain(
      'mcp_servers.agent-native-desktop-computer-2.url="http://127.0.0.1:43123/mcp"',
    );
  });

  it("preserves a file-config collision across both code-agent paths", () => {
    const token = "x".repeat(43);
    const environment = {
      AGENT_NATIVE_CODE_AGENT_MCP_SERVER_ALLOWLIST:
        "agent-native-desktop-computer",
      AGENT_NATIVE_DESKTOP_CHILD: "1",
      AGENT_NATIVE_DESKTOP_COMPUTER_MCP_URL: "http://127.0.0.1:43123/mcp",
      AGENT_NATIVE_DESKTOP_COMPUTER_MCP_TOKEN: token,
    } as NodeJS.ProcessEnv;
    const fileConfig: McpConfig = {
      source: "file:mcp.json",
      servers: {
        "agent-native-desktop-computer": {
          type: "http",
          url: "https://user.example/mcp",
        },
      },
    };

    const merged = mergeCodeAgentMcpConfig(fileConfig, environment)!;
    expect(
      Object.keys(restrictCodeAgentMcpConfig(merged, environment)!.servers),
    ).toEqual([
      "agent-native-desktop-computer",
      "agent-native-desktop-computer-2",
    ]);
    expect(codexMcpConfigArgs(fileConfig, environment).join("\n")).toContain(
      'mcp_servers.agent-native-desktop-computer-2.url="http://127.0.0.1:43123/mcp"',
    );
  });

  it("does not deliver an invalid desktop child bridge", () => {
    const environment = {
      AGENT_NATIVE_DESKTOP_CHILD: "1",
      AGENT_NATIVE_DESKTOP_COMPUTER_MCP_URL: "https://example.com/mcp",
      AGENT_NATIVE_DESKTOP_COMPUTER_MCP_TOKEN: "too-short",
    } as NodeJS.ProcessEnv;

    expect(mergeCodeAgentMcpConfig(null, environment)).toBeNull();
    expect(codexMcpConfigArgs(null, environment)).toEqual([]);
  });
});

describe("Codex settings carried by an MCP_SERVERS entry", () => {
  const songEntry = {
    type: "http",
    url: "http://127.0.0.1:8100/song-studio/mcp",
    headers: { Authorization: "Bearer fake-test-token" },
    startupTimeoutSec: 90,
    approveTools: true,
  };
  const envWith = (entry: Record<string, unknown>) =>
    ({
      MCP_SERVERS: JSON.stringify({
        servers: { desktop_app_song_studio: entry },
      }),
    }) as NodeJS.ProcessEnv;

  it("gives Codex the url, bearer header, a 90 s startup budget and tool approval", () => {
    expect(
      codexMcpConfigArgs(null, envWith(songEntry), {
        permissionMode: "full-auto",
      }),
    ).toEqual([
      "-c",
      'mcp_servers.desktop_app_song_studio.url="http://127.0.0.1:8100/song-studio/mcp"',
      "-c",
      'mcp_servers.desktop_app_song_studio.bearer_token_env_var="AGENT_NATIVE_MCP_DESKTOP_APP_SONG_STUDIO_TOKEN"',
      "-c",
      "mcp_servers.desktop_app_song_studio.startup_timeout_sec=90",
      "-c",
      'mcp_servers.desktop_app_song_studio.default_tools_approval_mode="approve"',
    ]);
  });

  it("keeps the bearer token out of argv and hands it over by variable name", () => {
    const args = codexMcpConfigArgs(null, envWith(songEntry), {
      permissionMode: "full-auto",
    });
    expect(JSON.stringify(args)).not.toContain("fake-test-token");
    expect(args.join("\n")).not.toContain("http_headers");
    expect(codexMcpChildEnv(null, envWith(songEntry))).toEqual({
      AGENT_NATIVE_MCP_DESKTOP_APP_SONG_STUDIO_TOKEN: "fake-test-token",
    });
  });

  it("moves only the bearer into the environment and keeps other headers", () => {
    const env = envWith({
      ...songEntry,
      headers: { Authorization: "Bearer fake-test-token", "X-Trace": "t1" },
    });
    expect(codexMcpConfigArgs(null, env).join("\n")).toContain(
      'mcp_servers.desktop_app_song_studio.http_headers={"X-Trace"="t1"}',
    );
  });

  it("keeps an argv header for a server that did not arrive through MCP_SERVERS", () => {
    const fileConfig: McpConfig = {
      servers: {
        repoServer: {
          type: "http",
          url: "https://repo.example/mcp",
          headers: { Authorization: "Bearer repo-token" },
        },
      },
    };
    expect(codexMcpConfigArgs(fileConfig, {} as NodeJS.ProcessEnv)).toEqual([
      "-c",
      'mcp_servers.repoServer.url="https://repo.example/mcp"',
      "-c",
      'mcp_servers.repoServer.http_headers={"Authorization"="Bearer repo-token"}',
    ]);
    expect(codexMcpChildEnv(fileConfig, {} as NodeJS.ProcessEnv)).toEqual({});
  });

  it("never lets a repo's mcp.config.json grant itself approval or a startup budget", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-repo-config-"));
    try {
      fs.writeFileSync(
        path.join(dir, "mcp.config.json"),
        JSON.stringify({
          servers: {
            repoServer: {
              type: "http",
              url: "https://repo.example/mcp",
              approveTools: true,
              startupTimeoutSec: 600,
            },
          },
        }),
      );
      const loaded = loadMcpConfig(dir);
      expect(loaded?.servers.repoServer).toBeDefined();
      const args = codexMcpConfigArgs(loaded, {} as NodeJS.ProcessEnv, {
        permissionMode: "full-auto",
      }).join("\n");
      expect(args).toContain("mcp_servers.repoServer.url=");
      expect(args).not.toContain("default_tools_approval_mode");
      expect(args).not.toContain("startup_timeout_sec");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores those settings on a config entry even if one carries them in memory", () => {
    const fileConfig = {
      servers: {
        repoServer: {
          type: "http",
          url: "https://repo.example/mcp",
          approveTools: true,
          startupTimeoutSec: 600,
        },
      },
    } as unknown as McpConfig;
    const args = codexMcpConfigArgs(fileConfig, {} as NodeJS.ProcessEnv, {
      permissionMode: "full-auto",
    }).join("\n");
    expect(args).not.toContain("default_tools_approval_mode");
    expect(args).not.toContain("startup_timeout_sec");
  });

  it("adds neither setting for an entry that does not ask for them", () => {
    const { startupTimeoutSec, approveTools, ...plain } = songEntry;
    void startupTimeoutSec;
    void approveTools;
    const args = codexMcpConfigArgs(null, envWith(plain)).join("\n");
    expect(args).not.toContain("startup_timeout_sec");
    expect(args).not.toContain("default_tools_approval_mode");
  });

  it("does not approve tools when the entry says false", () => {
    expect(
      codexMcpConfigArgs(null, envWith({ ...songEntry, approveTools: false }), {
        permissionMode: "full-auto",
      }).join("\n"),
    ).not.toContain("default_tools_approval_mode");
  });

  it("approves only for the invocation's own write-capable mode", () => {
    const approves = (permissionMode?: CodeAgentPermissionMode) =>
      codexMcpConfigArgs(null, envWith(songEntry), { permissionMode }).some(
        (arg) => arg.includes("default_tools_approval_mode"),
      );
    expect(approves("auto-edit")).toBe(true);
    expect(approves("full-auto")).toBe(true);
    expect(approves("read-only")).toBe(false);
    expect(approves("ask-before-edit")).toBe(false);
    expect(approves(undefined)).toBe(false);
    // The startup budget is not a permission and is kept in every mode.
    expect(
      codexMcpConfigArgs(null, envWith(songEntry), {
        permissionMode: "read-only",
      }),
    ).toContain("mcp_servers.desktop_app_song_studio.startup_timeout_sec=90");
  });

  it("rejects a bad setting loudly instead of dropping it", () => {
    for (const startupTimeoutSec of [0, 601, 1.5, "90", null]) {
      expect(() =>
        codexMcpConfigArgs(null, envWith({ ...songEntry, startupTimeoutSec })),
      ).toThrow(/startupTimeoutSec/);
    }
    expect(() =>
      codexMcpConfigArgs(null, envWith({ ...songEntry, approveTools: "yes" })),
    ).toThrow(/approveTools/);
  });

  it("keeps Codex-only settings out of Claude's config", () => {
    expect(claudeMcpConfig(null, envWith(songEntry))).toEqual({
      mcpServers: {
        desktop_app_song_studio: {
          type: "http",
          url: "http://127.0.0.1:8100/song-studio/mcp",
          headers: { Authorization: "Bearer fake-test-token" },
        },
      },
    });
  });
});
