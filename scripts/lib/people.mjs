/**
 * Making a person, for the verification scripts.
 *
 * A staff member now carries exactly one PRIMARY ROLE — their grade, which is
 * also their designation — and a laboratory professional belongs to exactly
 * one CLINICAL UNIT. A post such as Quality Manager is no longer something an
 * account can simply be given: it is a POSITION, and its access comes from
 * being appointed to it.
 *
 * Every check script used to write that out for itself, usually as
 * `roles.find(r => r.name === 'Technician')`, which stopped working the day
 * the grade was renamed to Medical Laboratory Technician. It lives here now,
 * once, and it matches tolerantly, so the next rename does not break fifteen
 * scripts again.
 *
 * Each helper takes the script's own `call(path, { token, method, body })`
 * helper, which they all share the shape of, and returns what it returns.
 */

/** Primary roles only — the grades a person can BE. */
export async function primaryRoles(call, token) {
  const res = await call('/roles?kind=primary', { token });
  return Array.isArray(res.json) ? res.json : [];
}

/**
 * A bench grade to test with. Matched on meaning rather than on an exact
 * name: "Medical Laboratory Technician" today, whatever it is called
 * tomorrow.
 */
export async function benchRole(call, token, want = /technician/i) {
  const roles = await primaryRoles(call, token);
  return roles.find(r => want.test(r.name))
    ?? roles.find(r => /scientist|technician|assistant/i.test(r.name))
    ?? roles.find(r => !r.isAdministrator)
    ?? roles[0];
}

/** A grade that needs no clinical unit — for a record that is not bench staff. */
export async function supportRole(call, token) {
  const roles = await primaryRoles(call, token);
  return roles.find(r => /administrative/i.test(r.name)) ?? roles.find(r => !r.isAdministrator) ?? roles[0];
}

/** A clinical unit to put somebody in. Administrative units are not one. */
export async function clinicalUnit(call, token) {
  const res = await call('/sections', { token });
  const units = Array.isArray(res.json) ? res.json : [];
  return units.find(u => u.unitKind !== 'administrative') ?? units[0];
}

/**
 * A staff record with a grade, and a clinical unit when the grade needs one.
 * Returns the created record's id.
 */
export async function makeStaff(call, token, fullName, extra = {}) {
  const role = extra.roleId ? { id: extra.roleId } : await benchRole(call, token);
  const unit = await clinicalUnit(call, token);
  const res = await call('/staff', {
    token, method: 'POST',
    body: { fullName, primaryRoleId: role.id, sectionId: unit?.id ?? null, ...extra },
  });
  return res.json?.id ?? null;
}

/**
 * A login, and the staff record behind it.
 *
 * Creating a login creates the person it belongs to, so the grade and the
 * clinical unit are supplied here rather than left for the server to refuse.
 */
export async function makeUser(call, token, { username, password, fullName, roleId, sectionId, ...rest }) {
  const role = roleId ? { id: roleId } : await benchRole(call, token);
  const unit = sectionId !== undefined ? { id: sectionId } : await clinicalUnit(call, token);
  return call('/users', {
    token, method: 'POST',
    body: { username, password, fullName, roleId: role.id, sectionId: unit?.id ?? null, ...rest },
  });
}

/**
 * Give somebody a post, and with it the post's access.
 *
 * This is how an account comes to work under a profile such as Quality
 * Manager: the profile belongs to the POSITION, and holding the position is
 * what confers it. Returns true when the appointment was made.
 */
export async function appointTo(call, token, staffId, titleMatch) {
  const res = await call('/positions', { token });
  const positions = Array.isArray(res.json) ? res.json : [];
  const post = positions.find(p => titleMatch.test(p.title) && p.isActive !== false);
  if (!post || !staffId) return false;
  const made = await call(`/staff/${staffId}/positions`, {
    token, method: 'POST', body: { positionId: post.id, assignmentType: 'primary' },
  });
  return made.status < 400;
}

/**
 * Somebody who works under a position's profile: a staff record, a login, and
 * the appointment that carries the access. Returns { staffId, username }.
 */
export async function makePostHolder(call, token, { username, password, fullName, titleMatch }) {
  const staffId = await makeStaff(call, token, fullName);
  await appointTo(call, token, staffId, titleMatch);
  await call('/users', {
    token, method: 'POST',
    body: { username, password, fullName, roleId: (await benchRole(call, token)).id, staffId },
  });
  return { staffId, username };
}

/** The probe account name the RBAC audit gives a profile. */
export function probeUsername(roleName) {
  return `probe_${String(roleName).toLowerCase().replace(/\W+/g, '_')}`;
}

/**
 * A probe account that genuinely works under one profile.
 *
 * A PRIMARY role is given to the account directly. A POSITION profile cannot
 * be: it belongs to the post, so the probe is appointed to a post that is
 * mapped to it, which is how a real holder comes by it. Returns the username,
 * or null when no post carries that profile and it therefore reaches nobody.
 */
export async function makeProbe(call, token, role, { password }) {
  const username = probeUsername(role.name);
  if (role.kind !== 'position') {
    const unit = await clinicalUnit(call, token);
    await call('/users', {
      token, method: 'POST',
      body: { username, password, fullName: `Probe ${role.name}`, roleId: role.id, sectionId: unit?.id ?? null },
    });
    return username;
  }

  const res = await call('/positions', { token });
  const positions = Array.isArray(res.json) ? res.json : [];
  const post = positions.find(p => Number(p.accessProfileId) === Number(role.id) && p.isActive !== false);
  if (!post) return null;

  const grade = await benchRole(call, token);
  const unit = await clinicalUnit(call, token);
  const staff = await call('/staff', {
    token, method: 'POST',
    body: { fullName: `Probe ${role.name}`, primaryRoleId: grade.id, sectionId: unit?.id ?? null },
  });
  const staffId = staff.json?.id;
  if (!staffId) return null;
  await call(`/staff/${staffId}/positions`, { token, method: 'POST', body: { positionId: post.id, assignmentType: 'primary' } });
  await call('/users', {
    token, method: 'POST',
    body: { username, password, fullName: `Probe ${role.name}`, roleId: grade.id, staffId },
  });
  return username;
}
