export function buildCaptureReport({
  outputDir,
  appName,
  businessName,
  packageName,
  bundleName,
  transport,
  serial,
  interfaceName,
  interfaceRef,
  phoneIp,
  startedAt,
  stoppedAt,
  finishedAt,
  pcapFile,
  screenRecordingFile,
  screenRecordingMode,
  rawPcap,
  mappingFile,
  extractedDir,
  extractionStatus,
  errors = [],
  diagnostics = [],
  marks = [],
}) {
  const lines = [
    '# Capture Report',
    '',
    `- Output Directory: ${outputDir || ''}`,
    `- App: ${appName || ''}`,
    `- Business: ${businessName || ''}`,
    `- Package: ${packageName || ''}`,
    `- Harmony Bundle: ${bundleName || ''}`,
    `- Transport: ${transport || ''}`,
    `- Device Serial: ${serial || ''}`,
    `- Interface: ${interfaceName || ''}`,
    `- Interface Ref: ${interfaceRef || ''}`,
    `- Phone IP: ${phoneIp || ''}`,
    `- Started At: ${startedAt || ''}`,
    `- Stopped At: ${stoppedAt || ''}`,
    `- Finished At: ${finishedAt || ''}`,
    `- PCAP: ${pcapFile || rawPcap || ''}`,
    `- Screen Recording: ${screenRecordingFile || ''}`,
    `- Screen Recording Mode: ${screenRecordingMode || ''}`,
    `- Port Mapping: ${mappingFile || ''}`,
    `- Extracted Output: ${extractedDir || ''}`,
    `- Extraction Status: ${extractionStatus || ''}`,
    '',
    '## Marks',
    '',
  ];

  if (marks.length === 0) {
    lines.push('- None');
  } else {
    for (const mark of marks) {
      lines.push(`- ${mark.label || 'mark'}: ${mark.at}`);
    }
  }

  lines.push('');
  lines.push('## Errors');
  lines.push('');
  if (errors.length === 0) {
    lines.push('- None');
  } else {
    for (const error of errors) lines.push(`- ${String(error).trim()}`);
  }

  lines.push('');
  lines.push('## Diagnostics');
  lines.push('');
  if (diagnostics.length === 0) {
    lines.push('- None');
  } else {
    for (const diagnostic of diagnostics) lines.push(`- ${String(diagnostic).trim()}`);
  }

  lines.push('');
  lines.push('## Notes');
  lines.push('');
  lines.push('- Capture should be filtered by package-derived port mapping and time window.');
  lines.push('- High-risk actions such as payment, ticket grabbing, order submission, likes, follows, comments, and rewards are not automated.');

  return lines.join('\n');
}
