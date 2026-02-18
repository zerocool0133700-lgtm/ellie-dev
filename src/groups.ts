/**
 * Groups, People & Memberships — Chain-scoped entity management
 *
 * ELLIE-52: TypeScript CRUD layer for the groups/people data model.
 * Groups and memberships are scoped by owner_id (chain owner).
 * People are global entities shared across chains.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

// ============================================================
// TYPES
// ============================================================

export interface Group {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  default_model: string | null;
  metadata: Record<string, any>;
  owner_id: string;
  created_at: string;
  updated_at: string;
}

export interface Person {
  id: string;
  name: string;
  relationship_type: string;
  notes: string | null;
  contact_methods: Record<string, any>;
  created_at: string;
  updated_at: string;
}

export interface GroupMembership {
  id: string;
  group_id: string;
  person_id: string;
  owner_id: string;
  role: string;
  access_level: string;
  joined_at: string;
}

export interface MemberWithPerson extends GroupMembership {
  person: Person;
}

export interface GroupWithMembers extends Group {
  members: Person[];
  member_count: number;
}

// ============================================================
// CHAIN OWNER
// ============================================================

/**
 * Get the chain owner (person with relationship_type = 'self').
 * In a single-user system, this is Dave.
 */
export async function getChainOwner(
  supabase: SupabaseClient,
): Promise<Person | null> {
  const { data, error } = await supabase
    .from("people")
    .select("*")
    .eq("relationship_type", "self")
    .limit(1)
    .single();

  if (error) return null;
  return data as Person;
}

// ============================================================
// GROUPS CRUD (chain-scoped by owner_id)
// ============================================================

export async function createGroup(
  supabase: SupabaseClient,
  params: {
    name: string;
    description?: string;
    icon?: string;
    default_model?: string;
    owner_id: string;
  },
): Promise<Group> {
  const { data, error } = await supabase
    .from("groups")
    .insert({
      name: params.name,
      description: params.description || null,
      icon: params.icon || null,
      default_model: params.default_model || null,
      owner_id: params.owner_id,
    })
    .select()
    .single();

  if (error) throw new Error(`Failed to create group: ${error.message}`);
  return data as Group;
}

export async function listGroups(
  supabase: SupabaseClient,
  owner_id: string,
): Promise<Group[]> {
  const { data, error } = await supabase
    .from("groups")
    .select("*")
    .eq("owner_id", owner_id)
    .order("created_at", { ascending: true });

  if (error) throw new Error(`Failed to list groups: ${error.message}`);
  return (data || []) as Group[];
}

export async function getGroup(
  supabase: SupabaseClient,
  id: string,
): Promise<Group | null> {
  const { data, error } = await supabase
    .from("groups")
    .select("*")
    .eq("id", id)
    .single();

  if (error) return null;
  return data as Group;
}

export async function updateGroup(
  supabase: SupabaseClient,
  id: string,
  updates: Partial<Pick<Group, "name" | "description" | "icon" | "default_model" | "metadata">>,
): Promise<Group> {
  const { data, error } = await supabase
    .from("groups")
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();

  if (error) throw new Error(`Failed to update group: ${error.message}`);
  return data as Group;
}

export async function deleteGroup(
  supabase: SupabaseClient,
  id: string,
): Promise<void> {
  const { error } = await supabase.from("groups").delete().eq("id", id);
  if (error) throw new Error(`Failed to delete group: ${error.message}`);
}

// ============================================================
// PEOPLE CRUD (global — no owner filtering)
// ============================================================

export async function createPerson(
  supabase: SupabaseClient,
  params: {
    name: string;
    relationship_type: string;
    notes?: string;
    contact_methods?: Record<string, any>;
  },
): Promise<Person> {
  const { data, error } = await supabase
    .from("people")
    .insert({
      name: params.name,
      relationship_type: params.relationship_type,
      notes: params.notes || null,
      contact_methods: params.contact_methods || {},
    })
    .select()
    .single();

  if (error) throw new Error(`Failed to create person: ${error.message}`);
  return data as Person;
}

export async function listPeople(
  supabase: SupabaseClient,
  filters?: { group_id?: string; search?: string },
): Promise<Person[]> {
  if (filters?.group_id) {
    // Get people in a specific group via memberships
    const { data: memberships } = await supabase
      .from("group_memberships")
      .select("person_id")
      .eq("group_id", filters.group_id);

    if (!memberships?.length) return [];

    const personIds = memberships.map((m: any) => m.person_id);
    let query = supabase.from("people").select("*").in("id", personIds).order("name");

    if (filters.search) query = query.ilike("name", `%${filters.search}%`);

    const { data, error } = await query;
    if (error) throw new Error(`Failed to list people: ${error.message}`);
    return (data || []) as Person[];
  }

  let query = supabase.from("people").select("*").order("name");
  if (filters?.search) query = query.ilike("name", `%${filters.search}%`);

  const { data, error } = await query;
  if (error) throw new Error(`Failed to list people: ${error.message}`);
  return (data || []) as Person[];
}

export async function getPerson(
  supabase: SupabaseClient,
  id: string,
): Promise<(Person & { memberships: GroupMembership[] }) | null> {
  const { data, error } = await supabase
    .from("people")
    .select("*")
    .eq("id", id)
    .single();

  if (error) return null;

  const { data: memberships } = await supabase
    .from("group_memberships")
    .select("*")
    .eq("person_id", id);

  return { ...(data as Person), memberships: (memberships || []) as GroupMembership[] };
}

export async function updatePerson(
  supabase: SupabaseClient,
  id: string,
  updates: Partial<Pick<Person, "name" | "relationship_type" | "notes" | "contact_methods">>,
): Promise<Person> {
  const { data, error } = await supabase
    .from("people")
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();

  if (error) throw new Error(`Failed to update person: ${error.message}`);
  return data as Person;
}

export async function deletePerson(
  supabase: SupabaseClient,
  id: string,
): Promise<void> {
  const { error } = await supabase.from("people").delete().eq("id", id);
  if (error) throw new Error(`Failed to delete person: ${error.message}`);
}

// ============================================================
// MEMBERSHIP CRUD
// ============================================================

export async function addMember(
  supabase: SupabaseClient,
  params: {
    group_id: string;
    person_id: string;
    owner_id: string;
    role?: string;
    access_level?: string;
  },
): Promise<GroupMembership> {
  const { data, error } = await supabase
    .from("group_memberships")
    .insert({
      group_id: params.group_id,
      person_id: params.person_id,
      owner_id: params.owner_id,
      role: params.role || "member",
      access_level: params.access_level || "full",
    })
    .select()
    .single();

  if (error) throw new Error(`Failed to add member: ${error.message}`);
  return data as GroupMembership;
}

export async function removeMember(
  supabase: SupabaseClient,
  group_id: string,
  person_id: string,
): Promise<void> {
  const { error } = await supabase
    .from("group_memberships")
    .delete()
    .eq("group_id", group_id)
    .eq("person_id", person_id);

  if (error) throw new Error(`Failed to remove member: ${error.message}`);
}

export async function listMembers(
  supabase: SupabaseClient,
  group_id: string,
): Promise<MemberWithPerson[]> {
  const { data: memberships, error } = await supabase
    .from("group_memberships")
    .select("*")
    .eq("group_id", group_id)
    .order("joined_at", { ascending: true });

  if (error) throw new Error(`Failed to list members: ${error.message}`);
  if (!memberships?.length) return [];

  const personIds = memberships.map((m: any) => m.person_id);
  const { data: people } = await supabase
    .from("people")
    .select("*")
    .in("id", personIds);

  const personMap = Object.fromEntries((people || []).map((p: any) => [p.id, p]));

  return memberships.map((m: any) => ({
    ...m,
    person: personMap[m.person_id] || null,
  })) as MemberWithPerson[];
}

// ============================================================
// HELPERS
// ============================================================

/**
 * Get all groups for an owner with their members.
 */
export async function getGroupsWithMembers(
  supabase: SupabaseClient,
  owner_id: string,
): Promise<GroupWithMembers[]> {
  const groups = await listGroups(supabase, owner_id);

  const results: GroupWithMembers[] = [];
  for (const group of groups) {
    const members = await listMembers(supabase, group.id);
    results.push({
      ...group,
      members: members.map((m) => m.person),
      member_count: members.length,
    });
  }

  return results;
}

/**
 * Get all groups a person belongs to.
 */
export async function getPersonGroups(
  supabase: SupabaseClient,
  person_id: string,
): Promise<Group[]> {
  const { data: memberships } = await supabase
    .from("group_memberships")
    .select("group_id")
    .eq("person_id", person_id);

  if (!memberships?.length) return [];

  const groupIds = memberships.map((m: any) => m.group_id);
  const { data, error } = await supabase
    .from("groups")
    .select("*")
    .in("id", groupIds)
    .order("name");

  if (error) return [];
  return (data || []) as Group[];
}
