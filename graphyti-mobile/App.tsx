import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Button, StyleSheet, Text, TextInput, View } from 'react-native';
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
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Query complete</Text>
        <Text style={styles.detail}>{JSON.stringify(queryState.result, null, 2)}</Text>
        <Button title="Run another query" onPress={() => setQueryState({ kind: 'idle' })} />
        <StatusBar style="auto" />
      </View>
    );
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
      {queryState.kind === 'error' && <Text style={styles.error}>{queryState.detail}</Text>}
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
  error: {
    alignSelf: 'stretch',
    marginBottom: 16,
    color: '#b91c1c',
    textAlign: 'center',
  },
});
