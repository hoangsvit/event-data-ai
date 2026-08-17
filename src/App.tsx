import React, { useState, useMemo } from 'react';
import { Header } from './components/Header';
import { Sidebar } from './components/Sidebar';
import { DashboardPage } from './components/pages/DashboardPage';
import { DataSourcesPage } from './components/pages/DataSourcesPage';
import { AiNormalizePage } from './components/pages/AiNormalizePage';
import { DataExplorerPage } from './components/pages/DataExplorerPage';
import { AskAiPage } from './components/pages/AskAiPage';

import {
  DataSource,
  FieldMapping,
  CanonicalFieldKey,
  AIInsight,
} from './types';
import { INITIAL_DEMO_SOURCES } from './data/demoData';
import {
  getDefaultMappingsForSources,
  applyMappingsToSources,
  detectDuplicateOrganizations,
  detectDuplicateParticipants,
  generateCalculatedAIInsights,
} from './utils/dataEngine';

export default function App() {
  const [currentPage, setCurrentPage] = useState<string>('dashboard');
  const [isMobileOpen, setIsMobileOpen] = useState(false);

  // Core Data State
  const [sources, setSources] = useState<DataSource[]>(INITIAL_DEMO_SOURCES);
  const [mappings, setMappings] = useState<FieldMapping[]>(() =>
    getDefaultMappingsForSources(INITIAL_DEMO_SOURCES)
  );
  const [isNormalized, setIsNormalized] = useState(true);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isGeneratingInsights, setIsGeneratingInsights] = useState(false);

  // Derived Consolidated Dataset
  const records = useMemo(() => {
    return applyMappingsToSources(sources, mappings);
  }, [sources, mappings]);

  // Derived Entity Resolution Groups
  const orgGroups = useMemo(() => {
    return detectDuplicateOrganizations(records);
  }, [records]);

  const participantGroups = useMemo(() => {
    return detectDuplicateParticipants(records);
  }, [records]);

  // AI Executive Insights State
  const [insights, setInsights] = useState<AIInsight[]>(() =>
    generateCalculatedAIInsights(records, orgGroups, participantGroups)
  );

  // Reset / Load Demo Dataset Handler
  const handleLoadDemo = () => {
    setSources(INITIAL_DEMO_SOURCES);
    const demoMappings = getDefaultMappingsForSources(INITIAL_DEMO_SOURCES);
    setMappings(demoMappings);
    setIsNormalized(true);

    const freshRecords = applyMappingsToSources(INITIAL_DEMO_SOURCES, demoMappings);
    const freshOrgs = detectDuplicateOrganizations(freshRecords);
    const freshParts = detectDuplicateParticipants(freshRecords);
    setInsights(generateCalculatedAIInsights(freshRecords, freshOrgs, freshParts));
  };

  // Add Custom Google Sheet Source
  const handleAddSource = (newSource: DataSource) => {
    const updatedSources = [...sources, newSource];
    setSources(updatedSources);

    const newMappings = getDefaultMappingsForSources([newSource]);
    setMappings((prev) => [...prev, ...newMappings]);
    setIsNormalized(false);
  };

  // Update Individual Mapping
  const handleUpdateMapping = (
    sourceId: string,
    sourceField: string,
    canonicalField: CanonicalFieldKey
  ) => {
    setMappings((prev) =>
      prev.map((m) => {
        if (m.sourceId === sourceId && m.sourceField === sourceField) {
          return {
            ...m,
            canonicalField,
            status: 'user_modified',
            confidence: 100,
            reasoning: `Manually set to ${canonicalField} by user.`,
          };
        }
        return m;
      })
    );
  };

  // Call Gemini Server Endpoint for Schema Analysis
  const handleAnalyzeWithGemini = async (selectedSourceIds: string[]) => {
    setIsAnalyzing(true);
    try {
      const targetSources = sources.filter((s) => selectedSourceIds.includes(s.id));
      const response = await fetch('/api/gemini/analyze-schema', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sources: targetSources }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Gemini schema analysis failed.');
      }

      if (data.mappings && Array.isArray(data.mappings)) {
        setMappings((prevMappings) => {
          const updatedMap = new Map<string, FieldMapping>(
            prevMappings.map((m) => [`${m.sourceId}::${m.sourceField}`, m])
          );

          data.mappings.forEach((resMapping: any) => {
            const key = `${resMapping.sourceId}::${resMapping.sourceField}`;
            const existing = updatedMap.get(key);
            if (existing) {
              const updatedItem: FieldMapping = {
                sourceId: existing.sourceId,
                sourceName: existing.sourceName,
                sourceField: existing.sourceField,
                sampleValues: existing.sampleValues,
                canonicalField: resMapping.canonicalField as CanonicalFieldKey,
                confidence: resMapping.confidence || 95,
                reasoning: resMapping.reasoning || 'Mapped by Gemini AI semantic engine.',
                status: 'auto',
              };
              updatedMap.set(key, updatedItem);
            }
          });

          return Array.from(updatedMap.values());
        });
      }
    } catch (err: any) {
      console.error('Error in analyze with Gemini:', err);
      alert('Gemini Schema Analysis notice: ' + (err.message || 'Used heuristic baseline mapping.'));
    } finally {
      setIsAnalyzing(false);
    }
  };

  // Confirm Normalization
  const handleConfirmNormalization = () => {
    setIsNormalized(true);
    setCurrentPage('explorer');
  };

  // Refresh AI Insights via Server Endpoint
  const handleRefreshInsights = async () => {
    setIsGeneratingInsights(true);
    try {
      const datasetMetrics = {
        totalRecords: records.length,
        uniqueParticipants: participantGroups.length,
        uniqueOrganizations: orgGroups.length,
        duplicateOrgClusters: orgGroups.filter((g) => g.variations.length > 1).length,
        crossEventParticipants: participantGroups.filter((p) => p.isCrossEvent).length,
      };

      const res = await fetch('/api/gemini/insights', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ datasetMetrics }),
      });

      const data = await res.json();
      if (data.insights && Array.isArray(data.insights) && data.insights.length > 0) {
        setInsights(
          data.insights.map((ins: any, idx: number) => ({
            id: `gemini-ins-${idx}`,
            title: ins.title,
            metric: ins.metric,
            description: ins.description,
            type: 'organization',
            calculatedFact: ins.description,
            actionableRecommendation: ins.actionableRecommendation,
          }))
        );
      }
    } catch (err) {
      console.error('Insights refresh notice:', err);
      setInsights(generateCalculatedAIInsights(records, orgGroups, participantGroups));
    } finally {
      setIsGeneratingInsights(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50/50 text-slate-900 font-sans antialiased flex flex-col">
      {/* Top Header */}
      <Header
        onLoadDemo={handleLoadDemo}
        isDemoLoaded={sources.length === INITIAL_DEMO_SOURCES.length}
        activeSourcesCount={sources.length}
        totalRecordsCount={records.length}
        isMobileOpen={isMobileOpen}
        setIsMobileOpen={setIsMobileOpen}
        onNavigate={setCurrentPage}
      />

      {/* Main Layout */}
      <div className="flex-1 max-w-7xl w-full mx-auto flex">
        {/* Sidebar */}
        <Sidebar
          currentPage={currentPage}
          onNavigate={setCurrentPage}
          isMobileOpen={isMobileOpen}
          setIsMobileOpen={setIsMobileOpen}
          sourcesCount={sources.length}
          normalizationStatus={isNormalized ? 'normalized' : 'analyzed'}
        />

        {/* Page Content Container */}
        <main className="flex-1 p-4 sm:p-6 lg:p-8 min-w-0">
          {currentPage === 'dashboard' && (
            <DashboardPage
              sources={sources}
              records={records}
              orgGroups={orgGroups}
              participantGroups={participantGroups}
              insights={insights}
              onNavigate={setCurrentPage}
              onRefreshInsights={handleRefreshInsights}
              isGeneratingInsights={isGeneratingInsights}
            />
          )}

          {currentPage === 'sources' && (
            <DataSourcesPage
              sources={sources}
              onAddSource={handleAddSource}
              onLoadDemo={handleLoadDemo}
              onNavigate={setCurrentPage}
            />
          )}

          {currentPage === 'normalize' && (
            <AiNormalizePage
              sources={sources}
              mappings={mappings}
              onUpdateMapping={handleUpdateMapping}
              onAnalyzeWithGemini={handleAnalyzeWithGemini}
              onConfirmNormalization={handleConfirmNormalization}
              isAnalyzing={isAnalyzing}
              isNormalized={isNormalized}
            />
          )}

          {currentPage === 'explorer' && (
            <DataExplorerPage
              records={records}
              sources={sources}
              orgGroups={orgGroups}
              participantGroups={participantGroups}
            />
          )}

          {currentPage === 'ask' && <AskAiPage records={records} />}
        </main>
      </div>
    </div>
  );
}
