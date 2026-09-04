/**
 * Minimal JSON-Schema subset validator for the MCP tool contract.
 *
 * Scope: only the external contract clients see (tool inputSchemas).
 * Supports the keywords used in src/tools.ts: type, required, properties,
 * items, minItems/maxItems, enum, oneOf/anyOf, additionalProperties.
 * Empty schemas ({}) allow anything (e.g. screenshot_views views items).
 *
 * Explicit inputs, structured returns — never throws for validation
 * failures, never reaches into helpers or serializers.
 *
 * @param {Record<string, any>} schema JSON-schema fragment
 * @param {unknown} value args value at this path
 * @param {string} field dot/bracket path naming this value ("" = root)
 * @returns {{ok:true}|{ok:false, field:string, message:string}}
 */
export function validateAgainstSchema(schema, value, field = "") {
  const at = (f) => (f === "" ? "(args)" : f);

  // Empty / absent schema allows anything.
  if (schema == null || schema === true || (typeof schema === "object" && Object.keys(schema).length === 0)) {
    return { ok: true };
  }

  // oneOf / anyOf: pass when any branch passes.
  for (const key of ["oneOf", "anyOf"]) {
    const branches = schema[key];
    if (Array.isArray(branches)) {
      let lastFailure = null;
      for (const branch of branches) {
        const r = validateAgainstSchema(branch, value, field);
        if (r.ok) return { ok: true };
        lastFailure = r;
      }
      return {
        ok: false,
        field: field === "" ? "" : field,
        message: `${at(field)} did not match any allowed form (${key}: ${lastFailure ? lastFailure.message : "no branches"})`,
      };
    }
  }

  // enum: leaf check (also enforced after type below).
  if (Array.isArray(schema.enum)) {
    if (!schema.enum.includes(value)) {
      return {
        ok: false,
        field,
        message: `${at(field)} must be one of ${JSON.stringify(schema.enum)}`,
      };
    }
    return { ok: true };
  }

  const types = schema.type == null ? null : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types == null) {
    // No type keyword: still honor object keywords when present.
    if (schema.properties || schema.required) {
      return validateObject(schema, value, field, at);
    }
    return { ok: true };
  }

  for (const t of types) {
    const r = validateType(t, schema, value, field, at);
    if (r.ok) return { ok: true };
    // For single-type schemas, return the failure directly (names the field).
    if (types.length === 1) return r;
  }
  return { ok: false, field, message: `${at(field)} must be of type ${types.join("|")}` };
}

function validateType(t, schema, value, field, at) {
  switch (t) {
    case "object":
      return validateObject(schema, value, field, at);
    case "array":
      return validateArray(schema, value, field, at);
    case "string":
      return typeof value === "string"
        ? { ok: true }
        : { ok: false, field, message: `${at(field)} must be a string` };
    case "number":
      return typeof value === "number" && !Number.isNaN(value)
        ? { ok: true }
        : { ok: false, field, message: `${at(field)} must be a number` };
    case "integer":
      return typeof value === "number" && Number.isInteger(value)
        ? { ok: true }
        : { ok: false, field, message: `${at(field)} must be an integer` };
    case "boolean":
      return typeof value === "boolean"
        ? { ok: true }
        : { ok: false, field, message: `${at(field)} must be a boolean` };
    case "null":
      return value === null ? { ok: true } : { ok: false, field, message: `${at(field)} must be null` };
    default:
      return { ok: true };
  }
}

function joinField(base, key) {
  return base === "" ? String(key) : `${base}.${String(key)}`;
}

function validateObject(schema, value, field, at) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, field, message: `${at(field)} must be an object` };
  }
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const key of required) {
    if (value[key] === undefined) {
      return { ok: false, field: joinField(field, key), message: `missing required field ${JSON.stringify(String(key))}` };
    }
  }
  const properties = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
  for (const key of Object.keys(properties)) {
    if (value[key] !== undefined) {
      const r = validateAgainstSchema(properties[key], value[key], joinField(field, key));
      if (!r.ok) return r;
    }
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!(key in properties)) {
        return { ok: false, field: joinField(field, key), message: `unknown field ${JSON.stringify(String(key))}` };
      }
    }
  }
  return { ok: true };
}

function validateArray(schema, value, field, at) {
  if (!Array.isArray(value)) {
    return { ok: false, field, message: `${at(field)} must be an array` };
  }
  if (typeof schema.minItems === "number" && value.length < schema.minItems) {
    return { ok: false, field, message: `${at(field)} must have at least ${schema.minItems} items (got ${value.length})` };
  }
  if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
    return { ok: false, field, message: `${at(field)} must have at most ${schema.maxItems} items (got ${value.length})` };
  }
  if (schema.items != null && typeof schema.items === "object") {
    for (let i = 0; i < value.length; i++) {
      const r = validateAgainstSchema(schema.items, value[i], `${field}[${i}]`);
      if (!r.ok) return r;
    }
  }
  return { ok: true };
}
