// Verifies the local-only hiring policy: a hosted-Claude actor (the CEO,
// adapterType `claude_local`) may only bring on workers that run on-box. Any
// agent it creates/hires on a non-local adapter is coerced onto the local
// gateway adapter, inheriting a sibling local worker's gateway connection
// settings. Board (human) actors are unrestricted. See LOCAL_HIRE_* in
// routes/agents.ts.
import express from "express";
import request from "supertest";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const mockAgentService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
}));
const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  decide: vi.fn(),
  hasPermission: vi.fn(),
  ensureMembership: vi.fn(),
  setPrincipalPermission: vi.fn(),
}));
const mockCompanySkillService = vi.hoisted(() => ({
  listRuntimeSkillEntries: vi.fn(),
  resolveRequestedSkillKeys: vi.fn(),
}));
const mockSecretService = vi.hoisted(() => ({
  normalizeAdapterConfigForPersistence: vi.fn(
    async (_companyId: string, config: Record<string, unknown>) => config,
  ),
  resolveAdapterConfigForRuntime: vi.fn(
    async (_companyId: string, config: Record<string, unknown>) => ({ config }),
  ),
  syncEnvBindingsForTarget: vi.fn(),
}));
const mockAgentInstructionsService = vi.hoisted(() => ({
  materializeManagedBundle: vi.fn(),
  getBundle: vi.fn(),
  readFile: vi.fn(),
  updateBundle: vi.fn(),
  writeFile: vi.fn(),
  deleteFile: vi.fn(),
  exportFiles: vi.fn(),
  ensureManagedBundle: vi.fn(),
}));
const mockApprovalService = vi.hoisted(() => ({ create: vi.fn(), getById: vi.fn() }));
const mockIssueApprovalService = vi.hoisted(() => ({ linkManyForApproval: vi.fn() }));
const mockBudgetService = vi.hoisted(() => ({ upsertPolicy: vi.fn() }));
const mockHeartbeatService = vi.hoisted(() => ({ cancelActiveForAgent: vi.fn() }));
const mockInstanceSettingsService = vi.hoisted(() => ({
  getGeneral: vi.fn(async () => ({ censorUsernameInLogs: false })),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  agentInstructionsService: () => mockAgentInstructionsService,
  accessService: () => mockAccessService,
  approvalService: () => mockApprovalService,
  builtInAgentService: () => ({ ensureCompanyDefaultAgentGrants: vi.fn() }),
  companySkillService: () => mockCompanySkillService,
  budgetService: () => mockBudgetService,
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => mockIssueApprovalService,
  issueService: () => ({}),
  logActivity: mockLogActivity,
  secretService: () => mockSecretService,
  syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
  workspaceOperationService: () => ({}),
}));
vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => mockInstanceSettingsService,
}));
vi.mock("../services/secrets.js", () => ({ secretService: () => mockSecretService }));

// Re-register after vi.resetModules() so a fresh routes/agents import (needed to
// re-read module-load env consts like PAPERCLIP_ENFORCE_LOCAL_HIRE) still sees mocks.
function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    agentService: () => mockAgentService,
    agentInstructionsService: () => mockAgentInstructionsService,
    accessService: () => mockAccessService,
    approvalService: () => mockApprovalService,
    builtInAgentService: () => ({ ensureCompanyDefaultAgentGrants: vi.fn() }),
    companySkillService: () => mockCompanySkillService,
    budgetService: () => mockBudgetService,
    heartbeatService: () => mockHeartbeatService,
    issueApprovalService: () => mockIssueApprovalService,
    issueService: () => ({}),
    logActivity: mockLogActivity,
    secretService: () => mockSecretService,
    syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
    workspaceOperationService: () => ({}),
  }));
  vi.doMock("../services/instance-settings.js", () => ({
    instanceSettingsService: () => mockInstanceSettingsService,
  }));
  vi.doMock("../services/secrets.js", () => ({ secretService: () => mockSecretService }));
}

const COMPANY_ID = "company-1";
const CEO_AGENT_ID = "ceo-agent-1";
const SIBLING_GATEWAY_CONFIG = {
  url: "http://100.72.16.52:3001",
  token: "gw-token-sibling",
  reasoning: false,
  timeoutSec: 600,
  paperclipApiUrl: "http://100.72.16.52:3120",
  containedWorkspace: true,
};

type Actor = Record<string, unknown>;

// A tiny drizzle-shaped stub. Table object identity is unreliable across
// vi.resetModules() (the fresh routes import pulls a different @paperclipai/db
// instance), so distinguish queries by SHAPE instead: the sibling-worker lookup
// chains `.orderBy().limit()`, while the company lookup awaits straight off
// `.where()`. Each `select()` gets its own flag so queries don't cross-talk.
function makeDb(opts: { hasSibling: boolean }) {
  const siblingRows = opts.hasSibling
    ? [
        {
          id: "sibling-gateway-1",
          companyId: COMPANY_ID,
          adapterType: "ironclaw_gateway",
          adapterConfig: SIBLING_GATEWAY_CONFIG,
          createdAt: new Date(0),
        },
      ]
    : [];
  const companyRows = [{ id: COMPANY_ID, requireBoardApprovalForNewAgents: false }];
  return {
    select: () => {
      let agentsQuery = false;
      const b: Record<string, unknown> = {};
      b.where = () => b;
      b.orderBy = () => {
        agentsQuery = true;
        return b;
      };
      b.limit = () => b;
      b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(agentsQuery ? siblingRows : companyRows).then(res, rej);
      return { from: () => b };
    },
  };
}

async function createApp(actor: Actor, db: unknown) {
  const [{ agentRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/agents.js")>("../routes/agents.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: Actor }).actor = actor;
    next();
  });
  app.use("/api", agentRoutes(db as never));
  app.use(errorHandler);
  return app;
}

function resetCommonMocks() {
  vi.clearAllMocks();
  mockCompanySkillService.listRuntimeSkillEntries.mockResolvedValue([]);
  mockCompanySkillService.resolveRequestedSkillKeys.mockResolvedValue([]);
  mockAccessService.decide.mockResolvedValue({ allowed: true, reason: "ok", explanation: "ok" });
  mockAccessService.canUser.mockResolvedValue(true);
  mockAccessService.hasPermission.mockResolvedValue(true);
  mockAccessService.ensureMembership.mockResolvedValue(undefined);
  mockAccessService.setPrincipalPermission.mockResolvedValue(undefined);
  mockLogActivity.mockResolvedValue(undefined);
  mockSecretService.syncEnvBindingsForTarget.mockResolvedValue(undefined);
  mockAgentInstructionsService.materializeManagedBundle.mockImplementation(
    async (agent: { adapterConfig: unknown }) => ({ adapterConfig: agent.adapterConfig }),
  );
  mockApprovalService.create.mockResolvedValue({ id: "approval-1" });
  mockAgentService.create.mockImplementation(
    async (_companyId: string, input: Record<string, unknown>) => ({
      id: String(input.id ?? "new-agent-1"),
      companyId: COMPANY_ID,
      name: String(input.name ?? "Agent"),
      urlKey: "agent",
      role: String(input.role ?? "general"),
      adapterType: input.adapterType,
      adapterConfig: input.adapterConfig ?? {},
      metadata: {},
      runtimeConfig: {},
    }),
  );
  // Actor CEO resolves as a hosted claude_local agent.
  mockAgentService.getById.mockImplementation(async (id: string) =>
    id === CEO_AGENT_ID
      ? { id: CEO_AGENT_ID, companyId: COMPANY_ID, adapterType: "claude_local", role: "ceo" }
      : null,
  );
}

const AGENT_ACTOR: Actor = {
  type: "agent",
  agentId: CEO_AGENT_ID,
  companyId: COMPANY_ID,
  companyIds: [COMPANY_ID],
};
const BOARD_ACTOR: Actor = {
  type: "board",
  userId: "human-1",
  companyIds: [COMPANY_ID],
  source: "local_implicit",
  isInstanceAdmin: false,
};

function hireBody(adapterType: string) {
  return {
    name: "TREK Data Engineer",
    role: "engineer",
    adapterType,
    adapterConfig: { model: "opus-5", engine: "acp" },
  };
}

describe("local-only hiring enforcement", () => {
  beforeEach(() => {
    vi.resetModules();
    registerModuleMocks();
    resetCommonMocks();
    delete process.env.PAPERCLIP_ENFORCE_LOCAL_HIRE;
  });
  afterEach(() => {
    delete process.env.PAPERCLIP_ENFORCE_LOCAL_HIRE;
  });

  it("coerces a claude_local CEO's claude_local hire onto the local gateway adapter", async () => {
    const app = await createApp(AGENT_ACTOR, makeDb({ hasSibling: true }));
    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/agent-hires`)
      .send(hireBody("claude_local"));
    expect(res.status).toBeLessThan(400);
    expect(mockAgentService.create).toHaveBeenCalledTimes(1);
    const created = mockAgentService.create.mock.calls[0][1] as Record<string, unknown>;
    expect(created.adapterType).toBe("ironclaw_gateway");
    // Inherited the sibling worker's gateway connection settings, not the CEO's config.
    expect(created.adapterConfig).toMatchObject({
      url: SIBLING_GATEWAY_CONFIG.url,
      token: SIBLING_GATEWAY_CONFIG.token,
      paperclipApiUrl: SIBLING_GATEWAY_CONFIG.paperclipApiUrl,
    });
    expect(created.adapterConfig).not.toHaveProperty("engine");
  });

  it("leaves a claude_local CEO's explicit ironclaw_gateway hire untouched", async () => {
    const app = await createApp(AGENT_ACTOR, makeDb({ hasSibling: true }));
    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/agent-hires`)
      .send({ name: "Local Worker", role: "engineer", adapterType: "ironclaw_gateway", adapterConfig: SIBLING_GATEWAY_CONFIG });
    expect(res.status).toBeLessThan(400);
    const created = mockAgentService.create.mock.calls[0][1] as Record<string, unknown>;
    expect(created.adapterType).toBe("ironclaw_gateway");
  });

  it("does NOT coerce a human board member's claude_local hire", async () => {
    const app = await createApp(BOARD_ACTOR, makeDb({ hasSibling: true }));
    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/agent-hires`)
      .send(hireBody("claude_local"));
    expect(res.status).toBeLessThan(400);
    const created = mockAgentService.create.mock.calls[0][1] as Record<string, unknown>;
    expect(created.adapterType).toBe("claude_local");
  });

  it("rejects a hosted hire when the company has no local worker to inherit from", async () => {
    const app = await createApp(AGENT_ACTOR, makeDb({ hasSibling: false }));
    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/agent-hires`)
      .send(hireBody("claude_local"));
    expect(res.status).toBe(422);
    expect(mockAgentService.create).not.toHaveBeenCalled();
  });

  it("honors PAPERCLIP_ENFORCE_LOCAL_HIRE=false (policy disabled)", async () => {
    process.env.PAPERCLIP_ENFORCE_LOCAL_HIRE = "false";
    const app = await createApp(AGENT_ACTOR, makeDb({ hasSibling: true }));
    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/agent-hires`)
      .send(hireBody("claude_local"));
    expect(res.status).toBeLessThan(400);
    const created = mockAgentService.create.mock.calls[0][1] as Record<string, unknown>;
    expect(created.adapterType).toBe("claude_local");
  });
});
