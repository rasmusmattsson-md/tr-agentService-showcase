import { supabase } from "./supabase/client";

export async function getOrCreateNewArtifact(params: {
  key: string;
  name: string;
  description?: string | null;
  runType: string;
}): Promise<string> {
  const { data: existing, error: existingErr } = await supabase
    .from("new_artifacts")
    .select("id")
    .eq("key", params.key)
    .maybeSingle();

  if (existingErr) throw existingErr;
  if (existing?.id) return existing.id;

  const { data: created, error: createErr } = await supabase.rpc(
    "create_new_artifact",
    {
      p_key: params.key,
      p_name: params.name,
      p_description: params.description ?? null,
      p_run_type: params.runType,
    }
  );

  if (createErr && createErr.code !== "23505") throw createErr;

  const createdRow = Array.isArray(created) ? created[0] : created;
  if (createdRow?.id) return createdRow.id;

  const { data: refetched, error: refetchErr } = await supabase
    .from("new_artifacts")
    .select("id")
    .eq("key", params.key)
    .maybeSingle();

  if (refetchErr) throw refetchErr;
  if (refetched?.id) return refetched.id;

  throw new Error(`Failed to resolve new_artifacts id for key: ${params.key}`);
}

export async function createNewArtifact(params: {
  key: string;
  name: string;
  description?: string | null;
  runType: string;
}): Promise<string> {
  const { data, error } = await supabase.rpc("create_new_artifact", {
    p_key: params.key,
    p_name: params.name,
    p_description: params.description ?? null,
    p_run_type: params.runType,
  });

  if (error) throw error;
  const created = Array.isArray(data) ? data[0] : data;
  if (!created?.id) throw new Error("create_new_artifact returned no id");
  return created.id as string;
}

export async function createNewArtifactRun(params: {
  artifactId: string;
  runType: string;
  conversationId?: string | null;
  agentId?: string | null;
  parameters?: Record<string, any>;
  definition?: Record<string, any>;
  output?: Record<string, any>;
}) {
  const { data, error } = await supabase.rpc("create_new_artifact_run", {
    p_artifact_id: params.artifactId,
    p_triggered_from_conversation_id: params.conversationId ?? null,
    p_triggered_by_agent_id: params.agentId ?? null,
    p_run_type: params.runType,
    p_parameters: params.parameters ?? {},
    p_definition: params.definition ?? {},
    p_output: params.output ?? {},
  });

  if (error) throw error;
  const run = Array.isArray(data) ? data[0] : data;
  if (!run?.id) throw new Error("create_new_artifact_run returned no id");
  return run.id as string;
}

export async function updateNewArtifactRun(params: {
  runId: string;
  parameters?: Record<string, any> | null;
  definition?: Record<string, any> | null;
  output?: Record<string, any> | null;
  entityId?: string | null;
  status?: string | null;
}) {
  const { data, error } = await supabase.rpc("update_new_artifact_run", {
    p_run_id: params.runId,
    p_parameters: params.parameters ?? null,
    p_definition: params.definition ?? null,
    p_output: params.output ?? null,
    p_entity_id: params.entityId ?? null,
    p_status: params.status ?? null,
  });

  if (error) throw error;
  return Array.isArray(data) ? data[0] : data;
}
