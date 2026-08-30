import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Animated, Easing, Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { getStatus, initGraph, streamQuery, type QueryResult, type QueryStreamEvent } from './src/api';

const C = { bg: '#0a0a0a', surface: '#0d0d0d', text: '#f5f5f5', muted: '#8a8a8a', divider: '#2a2a2a', accent: '#ff6a1a', rest: '#cc5514', hot: '#ff8128' } as const;
const BRAILLE = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧'];
const SUGGESTIONS = ['Add a summary field to Post', 'Rename User.bio to profileBio', 'Add a featured flag to Comment'];

type LaunchState = { kind: 'checking' } | { kind: 'initializing' } | { kind: 'ready'; nodeCount?: number } | { kind: 'network-error'; detail: string } | { kind: 'init-error'; detail: string };
type QueryState = { kind: 'idle' } | { kind: 'running'; query: string; events: QueryStreamEvent[]; connectionLost?: string; result?: QueryResult } | { kind: 'error'; detail: string };
type ResultTone = 'success' | 'blocked' | 'error';

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
function resultStatus(result: QueryResult): { tone: ResultTone; title: string; detail: string } {
  if (result.exitCode === 0 && result.filesWritten.length > 0) return { tone: 'success', title: 'SUCCESS', detail: `${result.filesWritten.length} file${result.filesWritten.length === 1 ? '' : 's'} written and committed` };
  if (result.exitCode === 1 || result.filesWritten.length === 0) return { tone: 'blocked', title: 'BLOCKED', detail: result.error ?? 'No files were written' };
  return { tone: 'error', title: 'ERROR', detail: result.error ?? 'The server reported an unexpected error' };
}

function BrailleSpinner({ active = true }: { active?: boolean }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => { if (!active) return; const timer = setInterval(() => setFrame((current) => (current + 1) % BRAILLE.length), 95); return () => clearInterval(timer); }, [active]);
  return <Text style={styles.spinner}>{BRAILLE[frame]}</Text>;
}

function Cursor() {
  const opacity = useRef(new Animated.Value(1)).current;
  useEffect(() => { const animation = Animated.loop(Animated.sequence([Animated.timing(opacity, { toValue: 0.15, duration: 450, easing: Easing.linear, useNativeDriver: true }), Animated.timing(opacity, { toValue: 1, duration: 450, easing: Easing.linear, useNativeDriver: true })])); animation.start(); return () => animation.stop(); }, [opacity]);
  return <Animated.Text style={[styles.cursor, { opacity }]}>▋</Animated.Text>;
}

function BrandButton({ title, onPress, disabled = false, outline = false }: { title: string; onPress: () => void; disabled?: boolean; outline?: boolean }) {
  return <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.button, outline ? styles.buttonOutline : styles.buttonFilled, disabled && styles.buttonDisabled, pressed && !disabled && styles.buttonPressed]}><Text style={[styles.buttonText, outline && styles.buttonOutlineText, disabled && styles.buttonDisabledText]}>{title}</Text></Pressable>;
}

function ResultSection({ title, children }: { title: string; children: ReactNode }) {
  return <View style={styles.resultSection}><Text style={styles.eyebrow}>{title}</Text>{children}</View>;
}

function ResultsSummary({ result, onReset }: { result: QueryResult; onReset: () => void }) {
  const status = resultStatus(result);
  const written = [...new Set(result.filesWritten)];
  return <View style={styles.resultsContainer}>
    <View style={styles.resultRule} />
    <Text style={[styles.resultStatus, status.tone === 'success' ? styles.resultSuccess : styles.resultMuted]}>{status.title}</Text>
    <Text style={styles.resultDetail}>{status.detail}</Text>
    {result.branch && <View style={styles.branchWrap}><Text style={styles.eyebrow}>COMMITTED BRANCH</Text><Pressable style={styles.branchChip} onPress={() => undefined}><Text selectable style={styles.branchName}>{result.branch}</Text></Pressable></View>}
    {result.prUrl && <Pressable onPress={() => void Linking.openURL(result.prUrl!)}><Text style={styles.prLink}>↗ Open draft pull request</Text></Pressable>}
    <ResultSection title="FILES WRITTEN">{written.length > 0 ? written.map((file) => <Text key={file} style={styles.codeRow}>› {file}</Text>) : <Text style={styles.muted}>No files were written.</Text>}</ResultSection>
    <ResultSection title="BLAST RADIUS">{result.blastRadius.length > 0 ? result.blastRadius.flatMap((blast) => [...blast.affectedRoutes, ...blast.affectedComponents, ...blast.affectedFiles]).map((file) => <Text key={file.id} style={styles.codeRow}>› {file.filePath} <Text style={styles.inlineMuted}>— {file.reason}</Text></Text>) : <Text style={styles.muted}>No affected source files reported.</Text>}</ResultSection>
    <ResultSection title="VERIFICATION">{result.verification.length > 0 ? result.verification.map((verification, index) => <View key={`${verification.summary}-${index}`} style={styles.verifyRows}><Text style={styles.verifyRow}>LOCAL CHECK <Text style={verification.localCheck.missed === 0 ? styles.pass : styles.fail}>{verification.localCheck.missed === 0 ? 'PASS' : 'BLOCKED'}</Text></Text><Text style={styles.verifyRow}>GRAPH CHECK <Text style={verification.graphCheckSkipped ? styles.inlineMuted : verification.graphCheck.missed === 0 ? styles.pass : styles.fail}>{verification.graphCheckSkipped ? 'SKIPPED' : verification.graphCheck.missed === 0 ? 'PASS' : 'WARN'}</Text></Text><Text style={styles.muted}>{verification.resolutionReason}</Text></View>) : <Text style={styles.muted}>No breaking-change verification was needed.</Text>}</ResultSection>
    <Text style={styles.elapsed}>Completed in {(result.elapsedMs / 1000).toFixed(1)}s</Text>
    <BrandButton title="RUN ANOTHER QUERY" onPress={onReset} outline />
  </View>;
}

function LiveQueryView({ state, onReset }: { state: Extract<QueryState, { kind: 'running' }>; onReset: () => void }) {
  const scrollRef = useRef<ScrollView>(null); const [autoScroll, setAutoScroll] = useState(true); const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (idleTimer.current) clearTimeout(idleTimer.current); }, []);
  const pauseAutoScroll = () => { setAutoScroll(false); if (idleTimer.current) clearTimeout(idleTimer.current); idleTimer.current = setTimeout(() => setAutoScroll(true), 4000); };
  const jumpToLatest = () => { setAutoScroll(true); scrollRef.current?.scrollToEnd({ animated: true }); };
  return <ScrollView ref={scrollRef} style={styles.liveScreen} contentContainerStyle={styles.liveContent} onScrollBeginDrag={pauseAutoScroll} onContentSizeChange={() => { if (autoScroll) scrollRef.current?.scrollToEnd({ animated: true }); }} scrollEventThrottle={16}>
    <View style={styles.liveHeader}><Text style={styles.brand}>graphyti</Text><Text style={styles.liveKicker}>LIVE PIPELINE</Text></View>
    <Text style={styles.liveQuery}>{state.query}</Text>
    <View style={styles.terminal}>{state.events.map((event, index) => {
      const previous = state.events[index - 1]; const isSection = event.status === 'start' || previous?.stage !== event.stage;
      const blast = event.stage === 'blast radius' && Array.isArray(event.data) ? event.data as Array<{ affectedRoutes?: Array<{ filePath: string; reason: string }>; affectedComponents?: Array<{ filePath: string; reason: string }>; affectedFiles?: Array<{ filePath: string; reason: string }> }> : null;
      const files = blast?.flatMap((item) => [...(item.affectedRoutes ?? []), ...(item.affectedComponents ?? []), ...(item.affectedFiles ?? [])]) ?? [];
      return <View key={`${event.stage}-${index}`} style={styles.logEntry}>{isSection && <Text style={styles.logSection}>// {event.stage.toUpperCase()}</Text>}<Text style={[styles.logLine, event.status === 'done' ? styles.logDone : event.status === 'error' ? styles.logError : styles.logMuted]}><Text style={styles.logPrompt}>› </Text>{event.message ?? event.stage}{event.elapsedMs === undefined ? '' : `  ${(event.elapsedMs / 1000).toFixed(1)}s`}</Text>{files.length > 0 && <View style={styles.blastBlock}><Text style={styles.blastTitle}>AFFECTED FILES</Text>{files.map((file, fileIndex) => <Text key={`${file.filePath}-${fileIndex}`} style={styles.blastFile}><Text style={styles.blastPath}>{file.filePath}</Text> <Text style={styles.inlineMuted}>— {file.reason}</Text></Text>)}</View>}</View>;
    })}{!state.result && !state.connectionLost && <View style={styles.cursorRow}><Cursor /></View>}</View>
    {!autoScroll && <Pressable style={styles.jumpPill} onPress={jumpToLatest}><Text style={styles.jumpText}>↓ JUMP TO LATEST</Text></Pressable>}
    {state.connectionLost && <View style={styles.connectionLost}><Text style={styles.connectionLostLabel}>CONNECTION LOST</Text><Text style={styles.connectionLostText}>{state.connectionLost}</Text></View>}
    {state.result && <ResultsSummary result={state.result} onReset={onReset} />}<StatusBar style="light" />
  </ScrollView>;
}

function QueryScreen({ nodeCount }: { nodeCount?: number }) {
  const [query, setQuery] = useState(''); const [focused, setFocused] = useState(false); const [queryState, setQueryState] = useState<QueryState>({ kind: 'idle' });
  const submit = () => { const submittedQuery = query.trim(); if (!submittedQuery) return; setQueryState({ kind: 'running', query: submittedQuery, events: [] }); streamQuery(submittedQuery, { onEvent: (event) => setQueryState((current) => current.kind !== 'running' ? current : { ...current, events: [...current.events, event], ...(event.stage === 'complete' && event.result ? { result: event.result } : {}) }), onConnectionLost: (detail) => setQueryState((current) => current.kind === 'running' && !current.result ? { ...current, connectionLost: detail } : current) }); };
  if (queryState.kind === 'running') return <LiveQueryView state={queryState} onReset={() => { setQuery(''); setQueryState({ kind: 'idle' }); }} />;
  return <View style={styles.queryScreen}><View style={styles.queryTopline}><Text style={styles.brand}>graphyti</Text><Text style={styles.nodeCount}>◉ {nodeCount ?? 0} NODES</Text></View><View style={styles.queryBody}><Text style={styles.queryEyebrow}>GRAPH-VERIFIED CHANGES</Text><Text style={styles.queryTitle}>What should change?</Text><Text style={styles.querySubtitle}>Describe the change in plain language. Graphyti maps the impact before it writes.</Text><TextInput multiline numberOfLines={4} placeholder="e.g. Add a summary field to Post" placeholderTextColor="#666" style={[styles.input, focused && styles.inputFocused]} value={query} onChangeText={setQuery} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} /><View style={styles.chips}>{SUGGESTIONS.map((suggestion) => <Pressable key={suggestion} style={styles.chip} onPress={() => setQuery(suggestion)}><Text style={styles.chipText}>{suggestion}</Text></Pressable>)}</View>{queryState.kind === 'error' && <Text style={styles.queryError}>{queryState.detail}</Text>}<BrandButton title="RUN QUERY →" disabled={!query.trim()} onPress={submit} /></View><Text style={styles.queryFootnote}>Graph context ready · changes land on a new branch</Text><StatusBar style="light" /></View>;
}

export default function App() {
  const [state, setState] = useState<LaunchState>({ kind: 'checking' });
  const checkGraph = useCallback(async () => { setState({ kind: 'checking' }); let status; try { status = await getStatus(); } catch (error) { setState({ kind: 'network-error', detail: errorMessage(error) }); return; } if (status.graphReady) { setState({ kind: 'ready', nodeCount: status.nodeCount }); return; } setState({ kind: 'initializing' }); try { const initialized = await initGraph(); setState({ kind: 'ready', nodeCount: initialized.nodeCount }); } catch (error) { setState({ kind: 'init-error', detail: errorMessage(error) }); } }, []);
  useEffect(() => { void checkGraph(); }, [checkGraph]);
  if (state.kind === 'ready') return <QueryScreen nodeCount={state.nodeCount} />;
  const loading = state.kind === 'checking' || state.kind === 'initializing'; const building = state.kind === 'initializing'; const networkError = state.kind === 'network-error';
  return <View style={styles.launchScreen}>{loading && <BrailleSpinner />}<Text style={styles.brandLarge}>graphyti</Text><Text style={styles.launchTitle}>{building ? 'Building graph context...' : state.kind === 'checking' ? 'Checking graph context...' : networkError ? "Can't reach Graphyti" : 'Could not build graph context'}</Text>{loading && <Text style={styles.launchDetail}>{building ? 'Mapping models, routes, and components.' : 'Connecting to your project graph.'}</Text>}{networkError && <Text style={styles.launchDetail}>Check the API is running and the tunnel URL is correct.{`\n\n`}{state.detail}</Text>}{state.kind === 'init-error' && <Text style={styles.launchDetail}>{state.detail}</Text>}{!loading && <BrandButton title="RETRY" onPress={() => void checkGraph()} outline />}<StatusBar style="light" /></View>;
}

const styles = StyleSheet.create({
  launchScreen: { alignItems: 'center', backgroundColor: C.bg, flex: 1, justifyContent: 'center', padding: 28 }, spinner: { color: C.accent, fontFamily: 'monospace', fontSize: 28, marginBottom: 18 }, brand: { color: C.accent, fontFamily: 'monospace', fontSize: 20, fontWeight: '700', letterSpacing: -1 }, brandLarge: { color: C.accent, fontFamily: 'monospace', fontSize: 34, fontWeight: '700', letterSpacing: -2 }, launchTitle: { color: C.text, fontSize: 20, fontWeight: '600', marginTop: 18, textAlign: 'center' }, launchDetail: { color: C.muted, lineHeight: 21, marginTop: 10, maxWidth: 300, textAlign: 'center' },
  queryScreen: { backgroundColor: C.bg, flex: 1, justifyContent: 'space-between', padding: 22 }, queryTopline: { alignItems: 'center', borderBottomColor: C.divider, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', justifyContent: 'space-between', paddingBottom: 17 }, nodeCount: { color: C.muted, fontFamily: 'monospace', fontSize: 11, letterSpacing: 0.6 }, queryBody: { flex: 1, justifyContent: 'center' }, queryEyebrow: { color: C.accent, fontFamily: 'monospace', fontSize: 11, fontWeight: '700', letterSpacing: 1, marginBottom: 12 }, queryTitle: { color: C.text, fontSize: 31, fontWeight: '700', letterSpacing: -0.8 }, querySubtitle: { color: C.muted, fontSize: 15, lineHeight: 22, marginBottom: 25, marginTop: 10 }, input: { alignSelf: 'stretch', backgroundColor: C.surface, borderColor: C.divider, borderRadius: 5, borderWidth: 1, color: C.text, fontSize: 17, lineHeight: 23, minHeight: 116, padding: 15, textAlignVertical: 'top' }, inputFocused: { borderColor: C.accent }, chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 25, marginTop: 12 }, chip: { borderColor: C.divider, borderRadius: 99, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 10, paddingVertical: 7 }, chipText: { color: C.muted, fontSize: 12 }, queryError: { color: C.hot, marginBottom: 12 }, queryFootnote: { color: C.muted, fontFamily: 'monospace', fontSize: 11, textAlign: 'center' },
  button: { alignItems: 'center', borderRadius: 4, justifyContent: 'center', minHeight: 50, paddingHorizontal: 18 }, buttonFilled: { backgroundColor: C.accent }, buttonOutline: { borderColor: C.accent, borderWidth: 1 }, buttonPressed: { opacity: 0.75 }, buttonDisabled: { backgroundColor: '#3a2418', borderColor: '#3a2418' }, buttonText: { color: C.bg, fontFamily: 'monospace', fontSize: 13, fontWeight: '800', letterSpacing: 0.7 }, buttonOutlineText: { color: C.accent }, buttonDisabledText: { color: '#956044' },
  liveScreen: { backgroundColor: C.bg, flex: 1 }, liveContent: { padding: 18, paddingBottom: 40 }, liveHeader: { alignItems: 'center', borderBottomColor: C.divider, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', justifyContent: 'space-between', paddingBottom: 14 }, liveKicker: { color: C.muted, fontFamily: 'monospace', fontSize: 10, letterSpacing: 1 }, liveQuery: { color: C.text, fontSize: 17, fontWeight: '600', lineHeight: 23, marginBottom: 18, marginTop: 16 }, terminal: { backgroundColor: C.surface, borderColor: C.divider, borderRadius: 5, borderWidth: StyleSheet.hairlineWidth, padding: 13 }, logEntry: { marginBottom: 9 }, logSection: { color: C.accent, fontFamily: 'monospace', fontSize: 11, fontWeight: '700', letterSpacing: 0.7, marginBottom: 3, marginTop: 4 }, logLine: { fontFamily: 'monospace', fontSize: 12, lineHeight: 18 }, logPrompt: { color: C.accent }, logMuted: { color: '#a1a1aa' }, logDone: { color: C.hot }, logError: { color: '#d1d1d1', textDecorationLine: 'underline' }, cursorRow: { flexDirection: 'row', height: 20, paddingLeft: 2 }, cursor: { color: C.accent, fontFamily: 'monospace', fontSize: 14 }, blastBlock: { borderLeftColor: C.rest, borderLeftWidth: 2, marginLeft: 7, marginTop: 7, paddingLeft: 10 }, blastTitle: { color: C.rest, fontFamily: 'monospace', fontSize: 10, fontWeight: '700', letterSpacing: 0.8, marginBottom: 3 }, blastFile: { color: C.text, fontFamily: 'monospace', fontSize: 11, lineHeight: 17 }, blastPath: { color: C.text }, inlineMuted: { color: C.muted }, jumpPill: { alignSelf: 'center', backgroundColor: '#21150e', borderColor: C.rest, borderRadius: 20, borderWidth: StyleSheet.hairlineWidth, marginTop: 14, paddingHorizontal: 13, paddingVertical: 8 }, jumpText: { color: C.accent, fontFamily: 'monospace', fontSize: 11, fontWeight: '700' }, connectionLost: { borderColor: C.rest, borderLeftWidth: 2, marginTop: 14, padding: 12 }, connectionLostLabel: { color: C.accent, fontFamily: 'monospace', fontSize: 12, fontWeight: '800', letterSpacing: 0.8 }, connectionLostText: { color: C.muted, marginTop: 5 },
  resultsContainer: { marginTop: 28 }, resultRule: { backgroundColor: C.divider, height: StyleSheet.hairlineWidth, marginBottom: 24 }, resultStatus: { fontFamily: 'monospace', fontSize: 30, fontWeight: '800', letterSpacing: 1 }, resultSuccess: { color: C.hot }, resultMuted: { color: C.text }, resultDetail: { color: C.muted, marginTop: 5 }, branchWrap: { marginTop: 24 }, eyebrow: { color: C.rest, fontFamily: 'monospace', fontSize: 10, fontWeight: '800', letterSpacing: 1, marginBottom: 8 }, branchChip: { alignSelf: 'flex-start', borderColor: C.divider, borderRadius: 4, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 9 }, branchName: { color: C.text, fontFamily: 'monospace', fontSize: 12 }, prLink: { color: C.accent, marginTop: 13, textDecorationLine: 'underline' }, resultSection: { borderTopColor: C.divider, borderTopWidth: StyleSheet.hairlineWidth, marginTop: 24, paddingTop: 18 }, codeRow: { color: C.text, fontFamily: 'monospace', fontSize: 12, lineHeight: 19 }, muted: { color: C.muted, lineHeight: 20 }, verifyRows: { gap: 5 }, verifyRow: { color: C.text, fontFamily: 'monospace', fontSize: 12 }, pass: { color: C.hot, fontWeight: '800' }, fail: { color: '#b9b9b9', fontWeight: '800' }, elapsed: { color: C.muted, fontFamily: 'monospace', fontSize: 11, marginVertical: 25, textAlign: 'center' },
});
