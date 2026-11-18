export function presentUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    phone: user.phone ?? null,
    status: user.status,
    timeZone: user.time_zone ?? null,
    mfaEnabled: user.mfa_enabled,
    lastLoginAt: user.last_login_at ?? null,
    createdAt: user.created_at,
  };
}

export function presentAssignment(row) {
  return {
    id: row.id,
    role: { id: row.role_id, key: row.role_key, name: row.role_name },
    unit: { id: row.unit_id, name: row.unit_name, type: row.unit_type, status: row.unit_status },
  };
}
