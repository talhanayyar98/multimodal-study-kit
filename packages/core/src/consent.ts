import type { ConsentDecision, ConsentRecord } from './manifest.js';
import type { Sensor, SensorDisclosure } from './sensor.js';
import { sha256Hex } from './util/sha256.js';

/** The participant's decision, as recorded by `session.consent()`. */
export interface ConsentInput {
  /** Version label of the consent text shown, e.g. the ethics approval reference. */
  textVersion: string;
  /**
   * The exact consent text (or HTML) shown. Only its SHA-256 goes into the manifest, so you can
   * later prove which text a participant saw without storing it with every session.
   */
  text?: string;
  /** Sensor ids the participant agreed to. Every other configured sensor is declined. */
  granted: readonly string[];
  /** Opt-ins the participant agreed to, as `<sensorId>.<option>` keys from `describe()`. */
  grantedOptions?: readonly string[];
}

/** Everything `session.describe()` returns. */
export interface SessionDisclosure {
  sensors: SensorDisclosure[];
  /**
   * Default English text generated from the configuration. Use it as a starting point inside your
   * ethics-approved consent form; translate or rewrite as needed and record the version you show.
   */
  text: string;
}

export function discloseSensor(sensor: Sensor): SensorDisclosure {
  const base = sensor.describe();
  return {
    sensorId: sensor.id,
    ...base,
    options: (sensor.options ?? []).map((o) => ({ ...o, key: `${sensor.id}.${o.id}` })),
  };
}

export function describeSensors(sensors: readonly Sensor[]): SessionDisclosure {
  const disclosures = sensors.map(discloseSensor);
  return { sensors: disclosures, text: disclosures.map(disclosureText).join('\n\n') };
}

function disclosureText(d: SensorDisclosure): string {
  const lines = [`${d.title}. ${d.summary}`];
  if (d.records.length) lines.push(`We record: ${joinList(d.records)}.`);
  if (d.neverRecords.length) lines.push(`We never record: ${joinList(d.neverRecords)}.`);
  for (const o of d.options) lines.push(`Optional (${o.title}): ${o.description}`);
  return lines.join('\n');
}

function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join('; ')}; and ${items.at(-1) ?? ''}`;
}

/**
 * Build the consent record. Throws on ids that aren't configured, so a typo can't silently
 * decline (or grant) the wrong thing.
 */
export async function buildConsentRecord(
  input: ConsentInput,
  sensors: readonly Sensor[],
  decidedAt: string,
): Promise<ConsentRecord> {
  if (typeof input.textVersion !== 'string' || !input.textVersion.trim()) {
    throw new TypeError('consent: textVersion is required');
  }
  if (input.textVersion.length > 128)
    throw new TypeError('consent: textVersion is longer than 128');
  const sensorIds = new Set(sensors.map((s) => s.id));
  for (const id of input.granted) {
    if (!sensorIds.has(id)) {
      throw new TypeError(
        `consent: "${id}" is not a configured sensor (have: ${[...sensorIds].join(', ')})`,
      );
    }
  }
  const optionKeys = new Set(
    sensors.flatMap((s) => (s.options ?? []).map((o) => `${s.id}.${o.id}`)),
  );
  for (const key of input.grantedOptions ?? []) {
    if (!optionKeys.has(key)) {
      throw new TypeError(
        `consent: "${key}" is not a requested option (have: ${[...optionKeys].join(', ') || 'none'})`,
      );
    }
  }

  const granted = new Set(input.granted);
  const grantedOptions = new Set(input.grantedOptions ?? []);
  const decisions: Record<string, ConsentDecision> = {};
  for (const s of sensors) decisions[s.id] = granted.has(s.id) ? 'granted' : 'declined';
  const options: Record<string, ConsentDecision> = {};
  for (const key of optionKeys) options[key] = grantedOptions.has(key) ? 'granted' : 'declined';

  return {
    textVersion: input.textVersion,
    textSha256: input.text === undefined ? null : await sha256Hex(input.text),
    decidedAt,
    decisions,
    options,
    withdrawal: null,
  };
}

/** Option ids granted to one sensor, without the prefix. An option on a declined sensor is moot. */
export function grantedOptionsFor(record: ConsentRecord, sensorId: string): Set<string> {
  const out = new Set<string>();
  if (record.decisions[sensorId] !== 'granted') return out;
  const prefix = `${sensorId}.`;
  for (const [key, decision] of Object.entries(record.options)) {
    if (decision === 'granted' && key.startsWith(prefix)) out.add(key.slice(prefix.length));
  }
  return out;
}
