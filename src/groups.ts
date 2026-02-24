/**
 * Groups, People & Memberships — Re-exported from ellie-forest
 *
 * ELLIE-52 → ELLIE-153: Moved from Supabase to local ellie-forest DB.
 * All CRUD now lives in ellie-forest/src/people.ts.
 * This file re-exports for backward compatibility with relay imports.
 */

export {
  // Types
  type Person,
  type Group,
  type GroupMembership,

  // Chain owner
  getChainOwner,

  // People CRUD
  createPerson,
  listPeople,
  getPerson,
  updatePerson,
  deletePerson,

  // Groups CRUD
  createGroup,
  listGroups,
  getGroup,
  updateGroup,
  deleteGroup,

  // Membership CRUD
  addMember,
  removeMember,
  listMembers,

  // Helpers
  getGroupsWithMembers,
  getPersonGroups,

  // Entity bridging
  ensurePersonEntity,
  ensureGroupEntity,
} from "../../ellie-forest/src/people.ts";
