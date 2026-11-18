'use client';

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api } from './api';
import type {
  AuditEntry,
  DeviceSession,
  Me,
  PermissionGroup,
  Person,
  Role,
  SettingDefinition,
  UnitSettings,
  UnitType,
  UserStatus,
} from './types';

export interface PeopleFilters {
  q: string;
  status: UserStatus | '';
}

/** Every cache key in one place, so mutations know what to refresh. */
export const keys = {
  me: ['me'] as const,
  unitTypes: ['unit-types'] as const,
  people: (unitId: string, filters: PeopleFilters) => ['people', unitId, filters] as const,
  peopleAll: ['people'] as const,
  person: (id: string) => ['person', id] as const,
  roles: (groupId: string) => ['roles', groupId] as const,
  rolesAll: ['roles'] as const,
  permissions: ['permissions'] as const,
  settingDefinitions: ['setting-definitions'] as const,
  settings: (unitId: string) => ['settings', unitId] as const,
  settingsAll: ['settings'] as const,
  audit: (unitId: string, action: string) => ['audit', unitId, action] as const,
  auditAll: ['audit'] as const,
  sessions: ['sessions'] as const,
};

export const fetchMe = () => api.get<Me>('/auth/me');

export function useMe() {
  return useQuery({ queryKey: keys.me, queryFn: fetchMe, retry: false, staleTime: 30_000 });
}

/** Definitions change only when the API is redeployed, so cache them for the session. */
export function useUnitTypes() {
  return useQuery({ queryKey: keys.unitTypes, queryFn: () => api.get<UnitType[]>('/org/unit-types'), staleTime: Infinity });
}

export function usePermissionCatalog(enabled = true) {
  return useQuery({
    queryKey: keys.permissions,
    queryFn: () => api.get<PermissionGroup[]>('/permissions'),
    staleTime: Infinity,
    enabled,
  });
}

export function useSettingDefinitions() {
  return useQuery({
    queryKey: keys.settingDefinitions,
    queryFn: () => api.get<SettingDefinition[]>('/settings/definitions'),
    staleTime: Infinity,
  });
}

export function useUnitSettings(unitId: string, enabled = true) {
  return useQuery({
    queryKey: keys.settings(unitId),
    queryFn: () => api.get<UnitSettings>('/settings', { unitId }),
    enabled,
  });
}

export function useRoles(groupId: string, enabled = true) {
  return useQuery({ queryKey: keys.roles(groupId), queryFn: () => api.get<Role[]>('/roles', { groupId }), enabled });
}

export function usePeople(unitId: string, filters: PeopleFilters, enabled = true) {
  return useInfiniteQuery({
    queryKey: keys.people(unitId, filters),
    queryFn: ({ pageParam }) =>
      api.page<Person>('/users', { unitId, q: filters.q, status: filters.status, cursor: pageParam, limit: 50 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled,
  });
}

export function usePerson(id: string | null) {
  return useQuery({
    queryKey: keys.person(id ?? 'none'),
    queryFn: () => api.get<Person>(`/users/${id}`),
    enabled: id !== null,
  });
}

export function useAudit(unitId: string, action: string, enabled = true, limit = 50) {
  return useInfiniteQuery({
    queryKey: [...keys.audit(unitId, action), limit],
    queryFn: ({ pageParam }) => api.page<AuditEntry>('/audit', { unitId, action, cursor: pageParam, limit }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled,
  });
}

export function useDeviceSessions(enabled = true) {
  return useQuery({ queryKey: keys.sessions, queryFn: () => api.get<DeviceSession[]>('/auth/sessions'), enabled });
}
