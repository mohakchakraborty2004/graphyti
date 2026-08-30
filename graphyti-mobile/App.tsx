import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Button, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { getStatus, initGraph, streamQuery, type QueryResult, type QueryStreamEvent } from './src/api';

type LaunchState =
  | { kind: 'checking' }
  | { kind: 'initializing' }
  | { kind: 'ready'; nodeCount?: number }
  | { kind: 'network-error'; detail: string }
  | { kind: 'init-error'; detail: string };

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

type QueryState =
  | { kind: 'idle' }
  | { kind: 'running'; query: string; events: QueryStreamEvent[]; connectionLost?: string; result?: QueryResult }
  | { kind: 'error'; detail: string };

type ResultTone = 'success' | 'blocked' | 'error';

function resultStatus(result: QueryResult): { tone: ResultTone; title: string; detail: string } {
  if (result.exitCode === 0 && result.filesWritten.length > 0) {
    return { tone: 'success', title: 'Changes committed', detail: `${result.filesWritten.length} file(s) written` };
  }
  if (result.exitCode === 1 || result.filesWritten.length === 0) {
    return { tone: 'blocked', title: 'Write blocked', detail: 'No files were written' };
  }
  return { tone: 'error', title: 'Query failed', detail: 'The server reported an unexpected error' };
}

function ResultsSummary({ result, onReset }: { result: QueryResult; onReset: () => void }) {
  const status = resultStatus(result);

  return (
    <View style={styles.resultsContainer}>
      <View style={[styles.statusBanner, styles[status.tone]]}>
        <Text style={styles.statusTitle}>{status.title}</Text>
        <Text style={styles.statusDetail}>{status.detail}</Text>
      </View>

      {status.tone === 'success' && result.branch && (
        <View style={styles.branchCard}>
          <Text style={styles.branchLabel}>Changes committed to</Text>
          <Text style={styles.branchName}>{result.branch}</Text>
        </View>
      )}
      {result.prUrl && <Text style={styles.prLink}>Draft PR: {result.prUrl}</Text>}

      <Text style={styles.sectionTitle}>Files written</Text>
      {result.filesWritten.length > 0 ? (
        result.filesWritten.map((file) => <Text key={file} style={styles.fileRow}>{file}</Text>)
      ) : (
        <Text style={styles.muted}>No files were written.</Text>
      )}

      <Text style={styles.sectionTitle}>Blast radius</Text>
      {result.blastRadius.length > 0 ? (
        result.blastRadius.flatMap((blast) => [
          ...blast.affectedRoutes,
          ...blast.affectedComponents,
          ...blast.affectedFiles,
        ]).map((file) => (
          <Text key={file.id} style={styles.fileRow}>{file.filePath}: {file.reason}</Text>
        ))
      ) : (
        <Text style={styles.muted}>No blast-radius changes were reported.</Text>
      )}

      <Text style={styles.sectionTitle}>Verification</Text>
      {result.verification.length > 0 ? result.verification.map((verification, index) => (
        <View key={`${verification.summary}-${index}`} style={styles.verificationCard}>
          <Text style={styles.muted}>Local check: {verification.localCheck.missed === 0 ? 'passed' : 'failed'} ({verification.localCheck.addressed} addressed, {verification.localCheck.missed} missed)</Text>
          <Text style={styles.muted}>
            Graph check: {verification.graphCheckSkipped
              ? 'skipped'
              : verification.graphCheck.missed === 0 && verification.graphCheck.staleNodesFound === 0
                ? 'passed'
                : 'completed with warnings'}
          </Text>
          <Text style={styles.muted}>{verification.resolutionReason}</Text>
        </View>
      )) : <Text style={styles.muted}>No breaking-change verification was needed.</Text>}

      <Text style={styles.elapsed}>Completed in {(result.elapsedMs / 1000).toFixed(1)}s</Text>
      <Button title="Run another query" onPress={onReset} />
    </View>
  );
}

function LiveQueryView({
  state,
  onReset,
}: {
  state: Extract<QueryState, { kind: 'running' }>;
  onReset: () => void;
}) {
  const scrollRef = useRef<ScrollView>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (idleTimer.current) clearTimeout(idleTimer.current);
  }, []);

  const pauseAutoScroll = () => {
    setAutoScroll(false);
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => setAutoScroll(true), 4000);
  };

  const jumpToLatest = () => {
    setAutoScroll(true);
    scrollRef.current?.scrollToEnd({ animated: true });
  };

  return (
    <ScrollView
      ref={scrollRef}
      style={styles.liveScreen}
      contentContainerStyle={styles.liveContent}
      onScrollBeginDrag={pauseAutoScroll}
      onContentSizeChange={() => {
        if (autoScroll) scrollRef.current?.scrollToEnd({ animated: true });
      }}
      scrollEventThrottle={16}
    >
      <Text style={styles.liveTitle}>Running query</Text>
      <Text style={styles.liveQuery}>{state.query}</Text>
      <View style={styles.terminal}>
        {state.events.map((event, index) => {
          const blast = event.stage === 'blast radius' && Array.isArray(event.data)
            ? event.data as Array<{ affectedRoutes?: Array<{ filePath: string; reason: string }>; affectedComponents?: Array<{ filePath: string; reason: string }>; affectedFiles?: Array<{ filePath: string; reason: string }> }>
            : null;
          return (
            <View key={`${event.stage}-${index}`}>
              <Text style={[styles.logLine, event.status === 'done' ? styles.logDone : event.status === 'error' ? styles.logError : styles.logMuted]}>
                [{event.status ?? 'update'}] {event.stage}: {event.message ?? ''}{event.elapsedMs === undefined ? '' : ` (${(event.elapsedMs / 1000).toFixed(1)}s)`}
              </Text>
              {blast && blast.flatMap((item) => [
                ...(item.affectedRoutes ?? []),
                ...(item.affectedComponents ?? []),
                ...(item.affectedFiles ?? []),
              ]).length > 0 && (
                <View style={styles.blastBlock}>
                  <Text style={styles.blastTitle}>Affected files</Text>
                  {blast.flatMap((item) => [
                    ...(item.affectedRoutes ?? []),
                    ...(item.affectedComponents ?? []),
                    ...(item.affectedFiles ?? []),
                  ]).map((file, fileIndex) => <Text key={`${file.filePath}-${fileIndex}`} style={styles.blastFile}>• {file.filePath} — {file.reason}</Text>)}
                </View>
              )}
            </View>
          );
        })}
        {!state.result && !state.connectionLost && <ActivityIndicator color="#cbd5e1" style={styles.logSpinner} />}
      </View>
      {!autoScroll && <Button title="Jump to latest" onPress={jumpToLatest} />}
      {state.connectionLost && <View style={styles.connectionLost}><Text style={styles.connectionLostText}>{state.connectionLost}</Text></View>}
      {state.result && <ResultsSummary result={state.result} onReset={onReset} />}
      <StatusBar style="auto" />
    </ScrollView>
  );
}

function QueryScreen({ nodeCount }: { nodeCount?: number }) {
  const [query, setQuery] = useState('');
  const [queryState, setQueryState] = useState<QueryState>({ kind: 'idle' });

  const submit = () => {
    const submittedQuery = query.trim();
    if (!submittedQuery) return;

    setQueryState({ kind: 'running', query: submittedQuery, events: [] });
    streamQuery(submittedQuery, {
      onEvent: (event) => setQueryState((current) => {
        if (current.kind !== 'running') return current;
        return {
          ...current,
          events: [...current.events, event],
          ...(event.stage === 'complete' && event.result ? { result: event.result } : {}),
        };
      }),
      onConnectionLost: (detail) => setQueryState((current) =>
        current.kind === 'running' && !current.result ? { ...current, connectionLost: detail } : current
      ),
    });
  };

  if (queryState.kind === 'running') {
    return <LiveQueryView state={queryState} onReset={() => {
      setQuery('');
      setQueryState({ kind: 'idle' });
    }} />;
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Graphyti</Text>
      <Text style={styles.subtitle}>
        {nodeCount === undefined ? 'Graph context detected' : `Graph context detected (${nodeCount} nodes)`}
      </Text>
      <Text style={styles.ready}>What would you like to change?</Text>
      <TextInput
        multiline
        numberOfLines={3}
        placeholder="e.g. Add a summary field to Post"
        style={styles.input}
        value={query}
        onChangeText={setQuery}
      />
      {queryState.kind === 'error' && <Text style={styles.queryError}>{queryState.detail}</Text>}
      <Button title="Run" disabled={!query.trim()} onPress={submit} />
      <StatusBar style="auto" />
    </View>
  );
}

export default function App() {
  const [state, setState] = useState<LaunchState>({ kind: 'checking' });

  const checkGraph = useCallback(async () => {
    setState({ kind: 'checking' });
    let status;
    try {
      status = await getStatus();
    } catch (error) {
      setState({ kind: 'network-error', detail: errorMessage(error) });
      return;
    }

    if (status.graphReady) {
      setState({ kind: 'ready', nodeCount: status.nodeCount });
      return;
    }

    setState({ kind: 'initializing' });
    try {
      const initialized = await initGraph();
      setState({ kind: 'ready', nodeCount: initialized.nodeCount });
    } catch (error) {
      setState({ kind: 'init-error', detail: errorMessage(error) });
    }
  }, []);

  useEffect(() => {
    void checkGraph();
  }, [checkGraph]);

  if (state.kind === 'ready') {
    return <QueryScreen nodeCount={state.nodeCount} />;
  }

  const isNetworkError = state.kind === 'network-error';
  const isInitError = state.kind === 'init-error';
  const loading = state.kind === 'checking' || state.kind === 'initializing';

  return (
    <View style={styles.container}>
      {loading && <ActivityIndicator size="large" />}
      <Text style={styles.title}>
        {state.kind === 'initializing'
          ? 'No graph context detected — building it now...'
          : state.kind === 'checking'
            ? 'Checking Graphyti context...'
            : isNetworkError
              ? "Can't reach Graphyti"
              : 'Could not build graph context'}
      </Text>
      {isNetworkError && (
        <Text style={styles.detail}>
          Check the API is running and the tunnel URL is correct.{`\n\n`}{state.detail}
        </Text>
      )}
      {isInitError && <Text style={styles.detail}>{state.detail}</Text>}
      {(isNetworkError || isInitError) && <Button title="Retry" onPress={() => void checkGraph()} />}
      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  title: {
    marginTop: 16,
    color: '#111827',
    fontSize: 20,
    fontWeight: '600',
    textAlign: 'center',
  },
  subtitle: {
    marginTop: 8,
    color: '#4b5563',
    fontSize: 16,
  },
  ready: {
    marginTop: 32,
    color: '#111827',
    fontSize: 18,
  },
  detail: {
    marginVertical: 20,
    color: '#4b5563',
    textAlign: 'center',
  },
  runningQuery: {
    marginVertical: 16,
    color: '#111827',
    fontSize: 18,
    fontWeight: '600',
    textAlign: 'center',
  },
  input: {
    alignSelf: 'stretch',
    minHeight: 88,
    marginVertical: 20,
    borderColor: '#9ca3af',
    borderRadius: 8,
    borderWidth: 1,
    padding: 12,
    textAlignVertical: 'top',
  },
  queryError: {
    alignSelf: 'stretch',
    marginBottom: 16,
    color: '#b91c1c',
    textAlign: 'center',
  },
  resultsContainer: {
    backgroundColor: '#fff',
    marginTop: 20,
  },
  statusBanner: {
    borderRadius: 10,
    marginBottom: 24,
    padding: 16,
  },
  success: {
    backgroundColor: '#dcfce7',
  },
  blocked: {
    backgroundColor: '#ffedd5',
  },
  error: {
    backgroundColor: '#e5e7eb',
  },
  statusTitle: {
    color: '#111827',
    fontSize: 20,
    fontWeight: '700',
  },
  statusDetail: {
    marginTop: 4,
    color: '#374151',
  },
  branchCard: {
    backgroundColor: '#eff6ff',
    borderRadius: 10,
    marginBottom: 24,
    padding: 16,
  },
  branchLabel: {
    color: '#1e3a8a',
    fontSize: 14,
  },
  branchName: {
    color: '#1e3a8a',
    fontSize: 17,
    fontWeight: '700',
    marginTop: 4,
  },
  sectionTitle: {
    color: '#111827',
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 8,
    marginTop: 16,
  },
  fileRow: {
    backgroundColor: '#f3f4f6',
    borderRadius: 6,
    color: '#111827',
    marginBottom: 6,
    padding: 10,
  },
  muted: {
    color: '#4b5563',
    lineHeight: 20,
  },
  elapsed: {
    color: '#6b7280',
    marginVertical: 28,
    textAlign: 'center',
  },
  verificationCard: {
    backgroundColor: '#f3f4f6',
    borderRadius: 6,
    gap: 4,
    marginBottom: 8,
    padding: 10,
  },
  prLink: {
    color: '#1d4ed8',
    marginBottom: 8,
  },
  liveScreen: {
    backgroundColor: '#020617',
    flex: 1,
  },
  liveContent: {
    padding: 18,
  },
  liveTitle: {
    color: '#e2e8f0',
    fontSize: 20,
    fontWeight: '700',
  },
  liveQuery: {
    color: '#94a3b8',
    marginBottom: 16,
    marginTop: 6,
  },
  terminal: {
    backgroundColor: '#111827',
    borderColor: '#334155',
    borderRadius: 8,
    borderWidth: 1,
    padding: 12,
  },
  logLine: {
    fontFamily: 'monospace',
    fontSize: 12,
    lineHeight: 18,
    marginBottom: 5,
  },
  logMuted: { color: '#94a3b8' },
  logDone: { color: '#86efac' },
  logError: { color: '#fca5a5' },
  logSpinner: { marginTop: 10 },
  blastBlock: {
    backgroundColor: '#172554',
    borderColor: '#3b82f6',
    borderLeftWidth: 3,
    marginBottom: 8,
    marginLeft: 8,
    padding: 8,
  },
  blastTitle: { color: '#bfdbfe', fontFamily: 'monospace', fontWeight: '700' },
  blastFile: { color: '#dbeafe', fontFamily: 'monospace', fontSize: 12, marginTop: 3 },
  connectionLost: {
    backgroundColor: '#7f1d1d',
    borderRadius: 8,
    marginTop: 12,
    padding: 12,
  },
  connectionLostText: { color: '#fecaca', textAlign: 'center' },
});
