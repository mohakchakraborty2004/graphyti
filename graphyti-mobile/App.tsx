import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Button, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { getStatus, initGraph, runQuery, type QueryResult } from './src/api';

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
  | { kind: 'running'; query: string }
  | { kind: 'result'; result: QueryResult }
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

function ResultsView({ result, onReset }: { result: QueryResult; onReset: () => void }) {
  const status = resultStatus(result);

  return (
    <ScrollView contentContainerStyle={styles.resultsContainer}>
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

      <Text style={styles.sectionTitle}>Files written</Text>
      {result.filesWritten.length > 0 ? (
        result.filesWritten.map((file) => <Text key={file} style={styles.fileRow}>{file}</Text>)
      ) : (
        <Text style={styles.muted}>No files were written.</Text>
      )}

      <Text style={styles.sectionTitle}>Blast radius</Text>
      {result.blastRadiusSize > 0 ? (
        <Text style={styles.muted}>
          Computed for {result.blastRadiusSize} affected file(s). This API response does not include their names or reasons yet.
        </Text>
      ) : (
        <Text style={styles.muted}>No blast-radius changes were reported.</Text>
      )}

      <Text style={styles.sectionTitle}>Verification</Text>
      <Text style={styles.muted}>
        {result.verification === 'skipped'
          ? 'Local and graph check details were not returned by the API for this query.'
          : `Verification: ${result.verification}`}
      </Text>

      <Text style={styles.elapsed}>Completed in {(result.elapsedMs / 1000).toFixed(1)}s</Text>
      <Button title="Run another query" onPress={onReset} />
      <StatusBar style="auto" />
    </ScrollView>
  );
}

function QueryScreen({ nodeCount }: { nodeCount?: number }) {
  const [query, setQuery] = useState('');
  const [queryState, setQueryState] = useState<QueryState>({ kind: 'idle' });

  const submit = async () => {
    const submittedQuery = query.trim();
    if (!submittedQuery) return;

    setQueryState({ kind: 'running', query: submittedQuery });
    try {
      setQueryState({ kind: 'result', result: await runQuery(submittedQuery) });
    } catch (error) {
      setQueryState({ kind: 'error', detail: errorMessage(error) });
    }
  };

  if (queryState.kind === 'running') {
    return (
      <View style={styles.container}>
        <Text style={styles.subtitle}>Running query</Text>
        <Text style={styles.runningQuery}>{queryState.query}</Text>
        <ActivityIndicator size="large" />
        <Text style={styles.detail}>Graphyti is analyzing your project. This can take a minute or more.</Text>
        <StatusBar style="auto" />
      </View>
    );
  }

  if (queryState.kind === 'result') {
    return <ResultsView result={queryState.result} onReset={() => {
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
      <Button title="Run" disabled={!query.trim()} onPress={() => void submit()} />
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
    flexGrow: 1,
    backgroundColor: '#fff',
    padding: 24,
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
});
