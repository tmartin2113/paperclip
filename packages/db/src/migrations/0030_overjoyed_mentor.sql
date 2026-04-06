ALTER TABLE "agent_runtime_state" ADD COLUMN "tokens_reset_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_runtime_state" ADD COLUMN "total_input_tokens_baseline" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runtime_state" ADD COLUMN "total_output_tokens_baseline" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runtime_state" ADD COLUMN "total_cached_input_tokens_baseline" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runtime_state" ADD COLUMN "total_cost_cents_baseline" bigint DEFAULT 0 NOT NULL;