import {
  DataSource,
  RawRow,
  FieldMapping,
  NormalizedRecord,
  DuplicateOrgGroup,
  DuplicateParticipantGroup,
  AIInsight,
  CanonicalFieldKey,
} from '../types';

/**
 * Normalizes company names for fuzzy grouping.
 * Strips prefixes like 'Công ty', 'Tập đoàn', 'Co., Ltd.', 'JSC', 'Inc', 'Corp' and cleans whitespace.
 */
export function sanitizeOrgName(orgName: string): string {
  if (!orgName) return '';
  let clean = orgName.toLowerCase().trim();
  
  // Remove common Vietnamese & English prefixes/suffixes
  clean = clean
    .replace(/^công ty\s+(tnhh\s+|jsc\s+|cổ phần\s+)?/gi, '')
    .replace(/^tập đoàn\s+/gi, '')
    .replace(/\s+co\.,?\s*ltd\.?/gi, '')
    .replace(/\s+jsc$/gi, '')
    .replace(/\s+corp(oration)?$/gi, '')
    .replace(/\s+inc\.?$/gi, '')
    .replace(/\s+llc$/gi, '')
    .trim();

  return clean;
}

/**
 * Generates default heuristic field mappings for sources when Gemini hasn't run yet.
 */
export function getDefaultMappingsForSources(sources: DataSource[]): FieldMapping[] {
  const mappings: FieldMapping[] = [];

  sources.forEach((source) => {
    source.columns.forEach((col) => {
      const lower = col.toLowerCase().trim();
      let canonicalField: CanonicalFieldKey = 'ignore';
      let confidence = 80;
      let reasoning = 'Matched based on standard column patterns.';

      if (
        lower.includes('doanh nghiệp') ||
        lower.includes('company') ||
        lower.includes('organization') ||
        lower.includes('công ty')
      ) {
        canonicalField = 'organization_name';
        confidence = 95;
        reasoning = `Matches organization keywords ("${col}").`;
      } else if (
        lower.includes('họ tên') ||
        lower.includes('participant') ||
        lower.includes('full name') ||
        lower.includes('name') ||
        lower.includes('tên')
      ) {
        canonicalField = 'participant_name';
        confidence = 94;
        reasoning = `Matches attendee name keywords ("${col}").`;
      } else if (
        lower.includes('email') ||
        lower.includes('mail') ||
        lower.includes('thư điện tử')
      ) {
        canonicalField = 'email';
        confidence = 99;
        reasoning = `Matches email contact pattern ("${col}").`;
      } else if (
        lower.includes('chức vụ') ||
        lower.includes('position') ||
        lower.includes('job title') ||
        lower.includes('title') ||
        lower.includes('vai trò')
      ) {
        canonicalField = 'position';
        confidence = 92;
        reasoning = `Matches position / job title role pattern ("${col}").`;
      } else if (
        lower.includes('sự kiện') ||
        lower.includes('event') ||
        lower.includes('program') ||
        lower.includes('dự án')
      ) {
        canonicalField = 'event_name';
        confidence = 96;
        reasoning = `Matches event program naming pattern ("${col}").`;
      }

      const sampleValues = source.sampleRows
        .map((r) => r[col])
        .filter(Boolean)
        .slice(0, 3);

      mappings.push({
        sourceId: source.id,
        sourceName: source.name,
        sourceField: col,
        canonicalField,
        confidence,
        reasoning,
        status: 'auto',
        sampleValues,
      });
    });
  });

  return mappings;
}

/**
 * Combines data sources using confirmed mappings into unified records.
 */
export function applyMappingsToSources(
  sources: DataSource[],
  mappings: FieldMapping[]
): NormalizedRecord[] {
  const records: NormalizedRecord[] = [];

  sources.forEach((source) => {
    const sourceMappings = mappings.filter((m) => m.sourceId === source.id);

    source.fullRows.forEach((row, index) => {
      const record: Partial<NormalizedRecord> = {
        id: `${source.id}-rec-${index + 1}`,
        source_id: source.id,
        source_name: source.name,
        original_row: row,
        participant_name: '',
        organization_name: '',
        email: '',
        position: '',
        event_name: source.name,
      };

      sourceMappings.forEach((m) => {
        if (m.canonicalField !== 'ignore' && row[m.sourceField]) {
          const val = row[m.sourceField].trim();
          if (m.canonicalField === 'participant_name') record.participant_name = val;
          else if (m.canonicalField === 'organization_name') record.organization_name = val;
          else if (m.canonicalField === 'email') record.email = val;
          else if (m.canonicalField === 'position') record.position = val;
          else if (m.canonicalField === 'event_name') record.event_name = val || source.name;
        }
      });

      // Ensure fallback event name if missing
      if (!record.event_name) {
        record.event_name = source.name;
      }

      // Only push if at least name or organization or email exists
      if (record.participant_name || record.organization_name || record.email) {
        records.push(record as NormalizedRecord);
      }
    });
  });

  return records;
}

/**
 * Detects potential duplicate company variations.
 */
export function detectDuplicateOrganizations(records: NormalizedRecord[]): DuplicateOrgGroup[] {
  const map: Map<string, { primaryName: string; variationsMap: Map<string, { sourceName: string; count: number }>; totalRecords: number; events: Set<string>; participants: Set<string> }> = new Map();

  records.forEach((r) => {
    if (!r.organization_name) return;
    const cleanKey = sanitizeOrgName(r.organization_name);
    if (!cleanKey) return;

    if (!map.has(cleanKey)) {
      map.set(cleanKey, {
        primaryName: r.organization_name,
        variationsMap: new Map(),
        totalRecords: 0,
        events: new Set(),
        participants: new Set(),
      });
    }

    const group = map.get(cleanKey)!;
    group.totalRecords += 1;
    if (r.event_name) group.events.add(r.event_name);
    if (r.email || r.participant_name) group.participants.add(r.email || r.participant_name);

    const varMap = group.variationsMap;
    const existingVar = varMap.get(r.organization_name);
    if (existingVar) {
      existingVar.count += 1;
    } else {
      varMap.set(r.organization_name, {
        sourceName: r.source_name,
        count: 1,
      });
    }

    // Keep cleanest or longest name as primary
    if (r.organization_name.length > group.primaryName.length && !r.organization_name.toLowerCase().startsWith('công ty')) {
      group.primaryName = r.organization_name;
    }
  });

  const result: DuplicateOrgGroup[] = [];

  map.forEach((val, key) => {
    const variationsArray = Array.from(val.variationsMap.entries()).map(([name, v]) => ({
      name,
      sourceName: v.sourceName,
      count: v.count,
    }));

    const isDuplicateCandidate = variationsArray.length > 1;
    const confidence = isDuplicateCandidate ? 92 : 100;

    result.push({
      normalizedKey: key,
      primaryName: val.primaryName,
      variations: variationsArray,
      totalRecords: val.totalRecords,
      participantCount: val.participants.size,
      events: Array.from(val.events),
      matchConfidence: confidence,
    });
  });

  // Sort groups with variations first, then total records descending
  return result.sort((a, b) => b.variations.length - a.variations.length || b.totalRecords - a.totalRecords);
}

/**
 * Detects cross-event attendees and email duplicates.
 */
export function detectDuplicateParticipants(records: NormalizedRecord[]): DuplicateParticipantGroup[] {
  const map: Map<string, { name: string; email: string; positions: Set<string>; orgs: Set<string>; events: Set<string>; count: number }> = new Map();

  records.forEach((r) => {
    const key = (r.email || r.participant_name || '').toLowerCase().trim();
    if (!key) return;

    if (!map.has(key)) {
      map.set(key, {
        name: r.participant_name,
        email: r.email,
        positions: new Set(),
        orgs: new Set(),
        events: new Set(),
        count: 0,
      });
    }

    const group = map.get(key)!;
    group.count += 1;
    if (r.participant_name && !group.name) group.name = r.participant_name;
    if (r.position) group.positions.add(r.position);
    if (r.organization_name) group.orgs.add(r.organization_name);
    if (r.event_name) group.events.add(r.event_name);
  });

  const result: DuplicateParticipantGroup[] = [];

  map.forEach((val) => {
    result.push({
      email: val.email,
      name: val.name,
      positions: Array.from(val.positions),
      organizations: Array.from(val.orgs),
      events: Array.from(val.events),
      count: val.count,
      isCrossEvent: val.events.size > 1,
    });
  });

  return result.sort((a, b) => b.count - a.count || b.events.length - a.events.length);
}

/**
 * Calculates facts and formats short executive insights.
 */
export function generateCalculatedAIInsights(
  records: NormalizedRecord[],
  orgGroups: DuplicateOrgGroup[],
  participantGroups: DuplicateParticipantGroup[]
): AIInsight[] {
  const insights: AIInsight[] = [];

  const totalOrgs = orgGroups.length;
  const multiEventOrgs = orgGroups.filter((g) => g.events.length > 1);
  const multiEventOrgPct = totalOrgs > 0 ? Math.round((multiEventOrgs.length / totalOrgs) * 100) : 0;

  insights.push({
    id: 'insight-1',
    title: 'Cross-Event Organizational Presence',
    metric: `${multiEventOrgPct}%`,
    description: `${multiEventOrgs.length} of ${totalOrgs} organizations attended multiple events across your portfolio.`,
    type: 'organization',
    calculatedFact: `Exact count: ${multiEventOrgs.length} organizations present in 2+ events (${multiEventOrgs.map((o) => o.primaryName).slice(0, 3).join(', ')}...).`,
    actionableRecommendation: 'Target these multi-event companies for enterprise partnership packages in 2027.',
  });

  const duplicateOrgCandidates = orgGroups.filter((g) => g.variations.length > 1);
  insights.push({
    id: 'insight-2',
    title: 'Schema Standardization & Duplicates',
    metric: `${duplicateOrgCandidates.length} Org Clusters`,
    description: `Found ${duplicateOrgCandidates.length} organization groups with naming variations (e.g., "ABC Technology" vs "ABC Technology Co., Ltd.").`,
    type: 'duplicate',
    calculatedFact: `${duplicateOrgCandidates.length} organization clusters have 2+ spelling/prefix variants across sources.`,
    actionableRecommendation: 'Review AI Normalize mappings or merge candidate names in Data Explorer.',
  });

  const crossEventParticipants = participantGroups.filter((p) => p.isCrossEvent);
  insights.push({
    id: 'insight-3',
    title: 'High-Value Repeat Attendees',
    metric: `${crossEventParticipants.length} VIP Attendees`,
    description: `${crossEventParticipants.length} individual participants registered for more than one event program.`,
    type: 'participation',
    calculatedFact: `Identified ${crossEventParticipants.length} attendees present in multiple rosters (e.g. ${crossEventParticipants.map((p) => p.name).slice(0, 3).join(', ')}).`,
    actionableRecommendation: 'Invite these active alumni to join the AI Riser Vietnam 2026 Advisory Board.',
  });

  // Highest event participation
  const eventCounts: Map<string, number> = new Map();
  records.forEach((r) => {
    if (r.event_name) {
      eventCounts.set(r.event_name, (eventCounts.get(r.event_name) || 0) + 1);
    }
  });

  let topEvent = { name: 'AI Innovation Summit 2026', count: 0 };
  eventCounts.forEach((count, name) => {
    if (count > topEvent.count) {
      topEvent = { name, count };
    }
  });

  insights.push({
    id: 'insight-4',
    title: 'Top Performing Event Program',
    metric: topEvent.name,
    description: `Leading event with ${topEvent.count} verified attendees registered across connected spreadsheets.`,
    type: 'quality',
    calculatedFact: `${topEvent.name} has ${topEvent.count} records (${Math.round((topEvent.count / (records.length || 1)) * 100)}% of total dataset).`,
    actionableRecommendation: 'Replicate this event structure and call-for-speakers for future workshops.',
  });

  return insights;
}

/**
 * Parses simple CSV string into raw rows object array.
 */
export function parseCSVToRawRows(csvText: string): { columns: string[]; rows: RawRow[] } {
  const lines = csvText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return { columns: [], rows: [] };
  }

  // Helper to split CSV line taking quotes into account
  const splitLine = (line: string): string[] => {
    const result: string[] = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        result.push(cur.trim().replace(/^"|"$/g, ''));
        cur = '';
      } else {
        cur += char;
      }
    }
    result.push(cur.trim().replace(/^"|"$/g, ''));
    return result;
  };

  const columns = splitLine(lines[0]);
  const rows: RawRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const vals = splitLine(lines[i]);
    const row: RawRow = {};
    columns.forEach((col, idx) => {
      row[col] = vals[idx] || '';
    });
    rows.push(row);
  }

  return { columns, rows };
}
