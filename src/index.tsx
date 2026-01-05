import { ActionPanel, Action, List, useNavigation, Clipboard, showToast, Toast, open, Icon, getPreferenceValues, confirmAlert, Alert, Color, closeMainWindow } from "@raycast/api"; 
import { useCachedState } from "@raycast/utils";
import { useEffect, useState, useMemo, useRef } from "react";
import { fetchSnippets, fetchDatabases, updateSnippetUsage, fetchSnippetContent, snippetIndexToSnippet } from "./api/notion";
import { Snippet, SnippetIndex, Preferences, DatabaseMetadata } from "./types/index";
import { parsePlaceholders, processOfficialPlaceholders } from "./utils/placeholder";
import SnippetForm from "./components/SnippetForm";
import FillerForm from "./components/FillerForm";
import fs from "fs";
import os from "os";
import path from "path";
import { exec } from "child_process";

export default function Command() {
  console.log("Rendering Notion Snippets Command...");

  // State - use lightweight indexes instead of full snippets
  const preferences = getPreferenceValues<Preferences>();
  const [showMetadata, setShowMetadata] = useCachedState<boolean>("show-metadata", preferences.showMetadata);
  const [snippetIndexes, setSnippetIndexes] = useCachedState<SnippetIndex[]>("notion-snippet-indexes", []);
  const [databases, setDatabases] = useCachedState<DatabaseMetadata[]>("notion-databases", []);
  
  // LRU Cache for full content - reduced to 20 items to prevent memory issues
  const contentCacheRef = useRef<Map<string, { content: string; lastAccess: number }>>(new Map());
  const MAX_CONTENT_CACHE_SIZE = 20;
  
  // Loading states for individual snippets
  const loadingContentRef = useRef<Set<string>>(new Set());
  const [selectedDbId, setSelectedDbId] = useState<string>("all");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [searchText, setSearchText] = useState("");
  const [isLoading, setIsLoading] = useState(snippetIndexes.length === 0);
  const [dbStatus, setDbStatus] = useState<string>("Initializing...");
  const [loadedContents, setLoadedContents] = useState<Map<string, string>>(new Map());
  const isSyncingRef = useRef(false);
  const lastSyncTimeRef = useRef(0);
  const hasAttemptedInitialLoad = useRef(false);
  const batchUpdateTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const pendingBatchRef = useRef<SnippetIndex[]>([]);
  const retryAttemptRef = useRef(0);
  const lastSavedCountRef = useRef(0);

  // Function to load full content on demand
  const loadSnippetContent = async (index: SnippetIndex): Promise<string> => {
    // Check cache first
    const cached = contentCacheRef.current.get(index.id);
    if (cached) {
      cached.lastAccess = Date.now();
      return cached.content;
    }
    
    // Check if already loading
    if (loadingContentRef.current.has(index.id)) {
      // Wait a bit and retry
      await new Promise(resolve => setTimeout(resolve, 100));
      const retryCached = contentCacheRef.current.get(index.id);
      if (retryCached) return retryCached.content;
    }
    
    // If content is short, use preview
    if (index.contentLength && index.contentLength <= 500 && index.contentPreview) {
      return index.contentPreview;
    }
    
    // Load from API
    loadingContentRef.current.add(index.id);
    try {
      const content = await fetchSnippetContent(index.id);
      
      // Update cache with LRU eviction - very aggressive cleanup
      if (contentCacheRef.current.size >= MAX_CONTENT_CACHE_SIZE) {
        // Remove least recently used - remove 70% to be very aggressive
        const entries = Array.from(contentCacheRef.current.entries());
        entries.sort((a, b) => a[1].lastAccess - b[1].lastAccess);
        const toRemove = entries.slice(0, Math.floor(MAX_CONTENT_CACHE_SIZE * 0.7)); // Remove 70%
        toRemove.forEach(([id]) => contentCacheRef.current.delete(id));
      }
      
      contentCacheRef.current.set(index.id, { content, lastAccess: Date.now() });
      setLoadedContents(new Map(contentCacheRef.current));
      return content;
    } finally {
      loadingContentRef.current.delete(index.id);
    }
  };

  const dbMap = useMemo(() => {
    const map: Record<string, DatabaseMetadata> = {};
    databases.forEach(db => { map[db.id] = db; });
    return map;
  }, [databases]);
  
/**
 * ... (skipping unchanged lines for brevity in tool call, will target specific lines)
 */


  
  // Hooks
  const { push } = useNavigation();

  useEffect(() => {
    let isMounted = true;
    async function load() {
      const now = Date.now();
      // Lock safety: if the lock is older than 30 seconds, assume it's stale (e.g. after crash/hot-reload)
      if (isSyncingRef.current && (now - lastSyncTimeRef.current < 30000)) {
        console.log("Index: Sync lock active and fresh, skipping auto-load");
        return;
      }

      try {
        isSyncingRef.current = true;
        lastSyncTimeRef.current = now;
        
        // Parallel metadata and snippets fetch
        fetchDatabases().then(dbs => {
          if (isMounted) {
            setDatabases(dbs || []);
            // If we find databases, we can at least show the empty list
            if (dbs && dbs.length > 0) setIsLoading(false);
          }
        });

        // We don't await fetchSnippets here to allow the UI to remain interactive
        // and show batches as they arrive.
        const allData = await fetchSnippets(
          (count) => {
             if (isMounted) {
               setDbStatus(`Syncing... checked ${count} items so far.`);
               setIsLoading(false); // Definitely stop loading once we have progress
               lastSavedCountRef.current = count;
             }
          },
          (batch) => {
            // Immediate processing with minimal batching to prevent memory buildup
            if (isMounted && batch.length > 0) {
              // Limit pending batch size to prevent accumulation
              if (pendingBatchRef.current.length > 50) {
                // Process existing batches first
                const batchesToProcess = pendingBatchRef.current.splice(0, 50);
                setSnippetIndexes(prev => {
                  const map = new Map(prev.map(s => [s.id, s]));
                  batchesToProcess.forEach(s => map.set(s.id, s));
                  return Array.from(map.values());
                });
              }
              
              pendingBatchRef.current.push(...batch);
              
              // Clear existing timeout
              if (batchUpdateTimeoutRef.current) {
                clearTimeout(batchUpdateTimeoutRef.current);
              }
              
              // Very frequent updates: every 100ms or when batch reaches 10 items
              batchUpdateTimeoutRef.current = setTimeout(() => {
                if (isMounted && pendingBatchRef.current.length > 0) {
                  const batchesToProcess = pendingBatchRef.current.splice(0, 10);
                  setSnippetIndexes(prev => {
                    const map = new Map(prev.map(s => [s.id, s]));
                    let hasChanges = false;
                    batchesToProcess.forEach(s => {
                      const existing = map.get(s.id);
                      if (!existing || existing.name !== s.name) {
                        map.set(s.id, s);
                        hasChanges = true;
                      }
                    });
                    return hasChanges ? Array.from(map.values()) : prev;
                  });
                  
                  // Aggressive cleanup: clear content cache more frequently
                  if (contentCacheRef.current.size > 20) {
                    const entries = Array.from(contentCacheRef.current.entries());
                    entries.sort((a, b) => a[1].lastAccess - b[1].lastAccess);
                    const toRemove = entries.slice(0, 10);
                    toRemove.forEach(([id]) => contentCacheRef.current.delete(id));
                  }
                }
              }, 100);
            }
          },
          async (error, dbId, pageCount, cursor) => {
            // Error handler for memory errors - returns true to retry
            const errorMessage = error?.message || String(error);
            const isMemoryError = errorMessage.includes("memory") || errorMessage.includes("heap");
            
            if (isMemoryError && retryAttemptRef.current < 3) {
              retryAttemptRef.current++;
              
              if (isMounted) {
                setDbStatus(`Memory error detected. Cleaning up and retrying... (Attempt ${retryAttemptRef.current}/3)`);
                
                // Aggressive cleanup
                contentCacheRef.current.clear();
                pendingBatchRef.current = [];
                
                // Force GC by clearing state temporarily
                await new Promise(resolve => setTimeout(resolve, 500));
                
                // Show toast
                showToast({
                  style: Toast.Style.Animated,
                  title: `Memory cleanup (Attempt ${retryAttemptRef.current}/3)`,
                  message: `Recovered ${lastSavedCountRef.current} items. Retrying...`
                });
              }
              
              return true; // Retry
            }
            
            return false; // Don't retry
          }
        );
        
        if (isMounted) {
          // Process any pending batches first
          if (pendingBatchRef.current.length > 0) {
            if (batchUpdateTimeoutRef.current) {
              clearTimeout(batchUpdateTimeoutRef.current);
              batchUpdateTimeoutRef.current = null;
            }
            const pending = pendingBatchRef.current.splice(0);
            allData.push(...pending);
          }
          
          // NO LIMITS - store all indexes
          setSnippetIndexes(prev => {
             const map = new Map(prev.map(s => [s.id, s]));
             allData.forEach(s => map.set(s.id, s));
             return Array.from(map.values());
          });
          setDbStatus(allData.length > 0 ? `Synced ${allData.length} snippets` : "No snippets found.");
        }
      } catch (error) {
        if (isMounted) {
          const errorMessage = String(error);
          const isMemoryError = errorMessage.includes("memory") || errorMessage.includes("heap");
          
          console.error("Index: Sync failed", error);
          
          if (isMemoryError && retryAttemptRef.current < 3) {
            // Auto-retry on memory error
            retryAttemptRef.current++;
            setDbStatus(`Memory error. Auto-retrying... (Attempt ${retryAttemptRef.current}/3)`);
            
            // Clean up aggressively
            contentCacheRef.current.clear();
            pendingBatchRef.current = [];
            
            // Wait and retry
            setTimeout(() => {
              if (isMounted) {
                load();
              }
            }, 2000);
            return; // Don't set loading to false yet
          } else {
            setDbStatus(`Sync Error: ${errorMessage}`);
            showToast({
              style: Toast.Style.Failure,
              title: "Sync Failed",
              message: isMemoryError 
                ? "Memory limit reached. Try reducing batch size or clearing cache."
                : errorMessage
            });
          }
        }
      } finally {
        if (!isMounted || retryAttemptRef.current >= 3) {
          isSyncingRef.current = false;
          retryAttemptRef.current = 0; // Reset retry count
          if (isMounted) setIsLoading(false);
        }
      }
    }
    load();
    return () => { 
      isMounted = false; 
      isSyncingRef.current = false; // Release lock on unmount (fixes Strict Mode double-invoke)
      // Clean up timeout and pending batches to prevent memory leaks
      if (batchUpdateTimeoutRef.current) {
        clearTimeout(batchUpdateTimeoutRef.current);
        batchUpdateTimeoutRef.current = null;
      }
      pendingBatchRef.current = [];
    };
  }, []); // Run ONLY on mount. Manual re-sync handles the rest.

  const refreshSnippets = async () => {
    if (isSyncingRef.current) {
      showToast({ style: Toast.Style.Failure, title: "Sync already in progress" });
      return;
    }

    console.log("refreshSnippets: Manually triggered");
    const toast = await showToast({ 
      style: Toast.Style.Animated, 
      title: "Syncing with Notion...",
      message: "Fetching metadata..."
    });
    
    isSyncingRef.current = true;
    setIsLoading(true);
    try {
      // 1. Fetch Databases first
      const dbs = await fetchDatabases();
      setDatabases(dbs || []);

      // 2. Fetch Snippets with progress and incremental loading
      retryAttemptRef.current = 0; // Reset retry count
      const data = await fetchSnippets(
        (count) => {
          toast.message = `Fetched ${count} snippets...`;
          lastSavedCountRef.current = count;
        },
        (batch) => {
          // Use smaller batches and more frequent updates
          pendingBatchRef.current.push(...batch);
          
          if (batchUpdateTimeoutRef.current) {
            clearTimeout(batchUpdateTimeoutRef.current);
          }
          
          // Limit pending batch size
          if (pendingBatchRef.current.length > 50) {
            const batchesToProcess = pendingBatchRef.current.splice(0, 50);
            setSnippetIndexes(prev => {
              const map = new Map(prev.map(s => [s.id, s]));
              batchesToProcess.forEach(s => map.set(s.id, s));
              return Array.from(map.values());
            });
          }
          
          batchUpdateTimeoutRef.current = setTimeout(() => {
            if (pendingBatchRef.current.length > 0) {
              const batchesToProcess = pendingBatchRef.current.splice(0, 10);
              setSnippetIndexes(prev => {
                const map = new Map(prev.map(s => [s.id, s]));
                let hasChanges = false;
                batchesToProcess.forEach(s => {
                  const existing = map.get(s.id);
                  if (!existing || existing.name !== s.name) {
                    map.set(s.id, s);
                    hasChanges = true;
                  }
                });
                return hasChanges ? Array.from(map.values()) : prev;
              });
              
              // Aggressive cleanup
              if (contentCacheRef.current.size > 20) {
                const entries = Array.from(contentCacheRef.current.entries());
                entries.sort((a, b) => a[1].lastAccess - b[1].lastAccess);
                const toRemove = entries.slice(0, 10);
                toRemove.forEach(([id]) => contentCacheRef.current.delete(id));
              }
            }
          }, 100);
        },
        async (error, dbId, pageCount, cursor) => {
          // Error handler for memory errors
          const errorMessage = error?.message || String(error);
          const isMemoryError = errorMessage.includes("memory") || errorMessage.includes("heap");
          
          if (isMemoryError && retryAttemptRef.current < 3) {
            retryAttemptRef.current++;
            
            toast.style = Toast.Style.Animated;
            toast.title = `Memory Cleanup (${retryAttemptRef.current}/3)`;
            toast.message = `Recovered ${lastSavedCountRef.current} items. Retrying...`;
            
            // Aggressive cleanup
            contentCacheRef.current.clear();
            pendingBatchRef.current = [];
            
            await new Promise(resolve => setTimeout(resolve, 500));
            
            return true; // Retry
          }
          
          return false; // Don't retry
        }
      );
      
      // Process any pending batches before final merge
      if (pendingBatchRef.current.length > 0) {
        if (batchUpdateTimeoutRef.current) {
          clearTimeout(batchUpdateTimeoutRef.current);
          batchUpdateTimeoutRef.current = null;
        }
        const pending = pendingBatchRef.current.splice(0);
        data.push(...pending);
      }
      
      // NO LIMITS - store all indexes
      // Final merge
      setSnippetIndexes(prev => {
        const map = new Map(prev.map(s => [s.id, s]));
        data.forEach(s => map.set(s.id, s));
        return Array.from(map.values());
      });
      
      const status = data.length > 0 
        ? `Found ${data.length} snippets in ${dbs.length} databases` 
        : "No snippets found.";
      
      setDbStatus(status);
      toast.style = Toast.Style.Success;
      toast.title = "Sync Complete";
      toast.message = status;
      
    } catch (error) {
      const errorMessage = String(error);
      const isMemoryError = errorMessage.includes("memory") || errorMessage.includes("heap");
      
      console.error("refreshSnippets: Failed", error);
      
      if (isMemoryError && retryAttemptRef.current < 3) {
        // Auto-retry on memory error
        retryAttemptRef.current++;
        toast.style = Toast.Style.Animated;
        toast.title = `Auto-retrying (${retryAttemptRef.current}/3)`;
        toast.message = "Cleaning up memory and retrying...";
        
        // Clean up aggressively
        contentCacheRef.current.clear();
        pendingBatchRef.current = [];
        
        // Wait and retry
        setTimeout(() => {
          refreshSnippets();
        }, 2000);
        return; // Don't set loading to false yet
      } else {
        setDbStatus(`Error: ${errorMessage}`);
        toast.style = Toast.Style.Failure;
        toast.title = "Sync Failed";
        toast.message = isMemoryError 
          ? "Memory limit reached after 3 retries. Try clearing cache or reducing data."
          : errorMessage;
      }
    } finally {
      if (retryAttemptRef.current >= 3) {
        retryAttemptRef.current = 0; // Reset retry count
      }
      isSyncingRef.current = false;
      setIsLoading(false);
    }
  };

  const forceReSync = async () => {
    const confirm = await confirmAlert({
      title: "Force Full Re-sync?",
      message: "This will clear your local cache and perform a complete 100% fresh pull from Notion.",
      primaryAction: { title: "Start Fresh Sync", style: Alert.ActionStyle.Destructive }
    });
    
    if (!confirm) return;

    // Show immediate feedback
    const toast = await showToast({ style: Toast.Style.Animated, title: "Clearing Cache & Restarting..." });
    
    setSnippetIndexes([]); 
    setDatabases([]);
    contentCacheRef.current.clear();
    setIsLoading(true);
    
    // We call refreshSnippets which will handle the rest of the Toast updates
    setTimeout(() => {
      refreshSnippets();
    }, 100);
  };

  const increaseUsage = (snippetId: string) => {
    // 1. Optimistic Update (Immediate UI feedback)
    const updatedIndexes = snippetIndexes.map(s => {
        if (s.id === snippetId) {
            return { 
                ...s, 
                usageCount: (s.usageCount || 0) + 1,
                lastUsed: new Date().toISOString()
            };
        }
        return s;
    });
    // Sort logic will automatically re-order them on next render if we updating state
    setSnippetIndexes(updatedIndexes);

    // 2. Fire and Forget API Update (Background)
    const snippet = snippetIndexes.find(s => s.id === snippetId);
    if (snippet) {
        // Use the OLD count for the increment logic in the API helper if needed, 
        // but here we pass the CURRENT known count. The API helper adds 1.
        updateSnippetUsage(snippetId, snippet.usageCount || 0).catch(err => {
            console.error("Background usage update failed", err);
        });
    }
  };

  const handleSelect = async (index: SnippetIndex) => {
    console.log(`handleSelect: Processing snippet "${index.name}"`);
    if (!index) return;
    
    // Load full content on demand
    const content = await loadSnippetContent(index);
    if (!content) {
      showToast({ style: Toast.Style.Failure, title: "Failed to load content" });
      return;
    }
    
    const snippet: Snippet = snippetIndexToSnippet(index, content);
    
    // Expand official Raycast placeholders first
    const clipboardText = await Clipboard.readText() || "";
    console.log(`handleSelect: Clipboard read (${clipboardText.length} chars)`);
    
    // Extract argument if searchText starts with trigger + space
    let argument = "";
    if (snippet.trigger && searchText.startsWith(snippet.trigger + " ")) {
      argument = searchText.substring(snippet.trigger.length + 1);
    }

    const expandedContent = processOfficialPlaceholders(snippet.content, clipboardText, argument);
    
    const placeholders = parsePlaceholders(expandedContent) || [];
    if (placeholders.length > 0) {
      console.log(`handleSelect: Found ${placeholders.length} custom placeholders, pushing FillerForm`);
      push(<FillerForm 
        snippet={{ ...snippet, content: expandedContent }} 
        placeholders={placeholders} 
        onPaste={() => {
            increaseUsage(snippet.id);
            closeMainWindow();
        }}
      />);
    } else {
      console.log("handleSelect: No placeholders left, pasting content...");
      increaseUsage(snippet.id);
      await Clipboard.paste(expandedContent);
      await closeMainWindow();
    }
  };

  const exportSelectedAndReveal = async () => {
    try {
      const indexesToExport = (selectedIds?.length || 0) > 0 
        ? snippetIndexes.filter(s => selectedIds.includes(s.id))
        : snippetIndexes;
      
      // Load full content for export
      const itemsToExport = await Promise.all(
        indexesToExport.map(async (index) => {
          const content = await loadSnippetContent(index);
          return snippetIndexToSnippet(index, content);
        })
      ); 

      if ((itemsToExport?.length || 0) === 0) {
        throw new Error("No snippets selected to export.");
      }

      if (await confirmAlert({
        title: "Enable Global Triggers",
        message: "To use triggers in any application, you must import these snippets into Raycast's native database.\n\n1. We will generate a JSON file.\n2. Open Raycast Settings > Extensions > Snippets.\n3. Select 'Import Snippets' and choose this file.",
        primaryAction: { title: "Export & Reveal JSON" },
        dismissAction: { title: "Cancel" },
      }) === false) {
        return;
      }

      const raycastSnippets = itemsToExport.map((s) => ({
        name: s.name,
        text: s.content,
        keyword: s.trigger || "",
      }));

      const fileName = itemsToExport.length === 1 ? `snippet_${itemsToExport[0].name.substring(0, 10)}.json` : `selected_${itemsToExport.length}_snippets.json`;
      const exportPath = path.join(os.homedir(), "Downloads", fileName);
      fs.writeFileSync(exportPath, JSON.stringify(raycastSnippets, null, 2));

      const script = `tell application "Finder" to reveal posix file "${exportPath}"
      tell application "Finder" to activate`;
      
      exec(`osascript -e '${script}'`);

      await showToast({
        style: Toast.Style.Success,
        title: `Exported ${itemsToExport.length} Snippets`,
        message: "File highlighted in Finder. Drag it to Raycast settings.",
      });

      await open("raycast://extensions/raycast/snippets/manage-snippets");
      
    } catch (error) {
      showToast({
        style: Toast.Style.Failure,
        title: "Export Failed",
        message: String(error),
      });
    }
  };

  const filteredAndSortedSnippets = useMemo(() => {
    return (snippetIndexes || [])
      .filter((snippet) => {
        if (selectedDbId !== "all" && snippet.databaseId !== selectedDbId) return false;

        if (!searchText) return true;
        const lowerSearch = searchText.toLowerCase();
        const lowerName = (snippet.name || "").toLowerCase();
        const lowerTrigger = (snippet.trigger || "").toLowerCase();
        
        // Match name or trigger
        if (lowerName.includes(lowerSearch) || lowerTrigger.includes(lowerSearch)) return true;

        // Trigger + argument match
        if (snippet.trigger && lowerSearch.startsWith(lowerTrigger + " ")) return true;
        
        return false;
      })
      .sort((a, b) => {
        // Exact trigger match
        if (searchText && a.trigger === searchText) return -1;
        if (searchText && b.trigger === searchText) return 1;
        
        // Case-insensitive trigger match
        if (searchText && a.trigger?.toLowerCase() === searchText.toLowerCase()) return -1;
        if (searchText && b.trigger?.toLowerCase() === searchText.toLowerCase()) return 1;

        // Usage Count (High to Low)
        const usageA = a.usageCount || 0;
        const usageB = b.usageCount || 0;
        if (usageA !== usageB) return usageB - usageA;

        // Last Used (Recent first)
        const dateA = a.lastUsed ? new Date(a.lastUsed).getTime() : 0;
        const dateB = b.lastUsed ? new Date(b.lastUsed).getTime() : 0;
        if (dateA !== dateB) return dateB - dateA;

        // Name alphabetical
        return a.name.localeCompare(b.name);
      });
  }, [snippetIndexes, selectedDbId, searchText]);

  const placeholder = useMemo(() => {
    const total = snippetIndexes.length;
    const filtered = filteredAndSortedSnippets.length;
    if (isLoading && total === 0) return "Connecting to Notion...";
    if (searchText) return `Found ${filtered} of ${total} snippets...`;
    return `Search across ${total} snippets...`;
  }, [snippetIndexes.length, filteredAndSortedSnippets.length, searchText, isLoading]);

  return (
    <List 
      isLoading={isLoading} 
      searchBarPlaceholder={placeholder}
      isShowingDetail={true}
      onSearchTextChange={setSearchText}
      onSelectionChange={(ids) => {
        if (!ids) {
          setSelectedIds([]);
        } else if (Array.isArray(ids)) {
          setSelectedIds(ids);
        } else {
          setSelectedIds([ids as string]);
        }
      }}
      searchBarAccessory={
        <List.Dropdown
          tooltip="Filter by Database"
          storeValue={true}
          onChange={(newValue) => setSelectedDbId(newValue)}
        >
          <List.Dropdown.Section title="Databases">
            <List.Dropdown.Item title="All Snippets" value="all" />
            {databases.map((db) => (
              <List.Dropdown.Item key={db.id} title={db.title} value={db.id} icon={db.icon} />
            ))}
          </List.Dropdown.Section>
        </List.Dropdown>
      }
    >
      <List.EmptyView
        title="Sync Status"
        description={`${dbStatus}\n\nCurrent Configured IDs: ${preferences.databaseIds || ""}`}
        actions={
          <ActionPanel>
            <Action
              title="Open Notion Integration Settings"
              onAction={() =>
                open("https://www.notion.so/my-integrations")
              }
            />
            <Action
              title="Retry Fetch"
              icon={Icon.Repeat}
              onAction={() => {
                setIsLoading(true);
                Promise.all([fetchSnippets(), fetchDatabases()]).then(([data, dbs]) => {
                  const safeData = data || [];
                  setSnippetIndexes(safeData);
                  setDatabases(dbs);
                  setDbStatus(safeData.length > 0 ? `Loaded ${safeData.length} snippets` : "Still no snippets found.");
                  setIsLoading(false);
                });
              }}
            />
            <Action
              title="Create New Snippet"
              icon={Icon.Plus}
              shortcut={{ modifiers: ["cmd"], key: "n" }}
              onAction={() => push(<SnippetForm onSuccess={refreshSnippets} />)}
            />
            <Action 
              title={showMetadata ? "Hide Metadata" : "Show Metadata"}
              icon={showMetadata ? Icon.EyeDisabled : Icon.Eye}
              shortcut={{ modifiers: ["cmd", "shift"], key: "d" }}
              onAction={() => setShowMetadata(!showMetadata)}
            />
          </ActionPanel>
        }
      />
      {filteredAndSortedSnippets.map((index) => {
          // Load content on demand for preview
          const cachedContent = contentCacheRef.current.get(index.id);
          const displayContent = cachedContent?.content || index.contentPreview || "Loading...";
          
          // Parse placeholders from preview or cached content
          let placeholders: string[] = [];
          if (cachedContent?.content) {
            placeholders = parsePlaceholders(cachedContent.content);
          } else if (index.contentPreview) {
            placeholders = parsePlaceholders(index.contentPreview);
          }
          
          // Highlight content
          let highlightedContent = displayContent.replace(/(\{?\{{1,2}.*?\}{1,2}\}?)/g, "**`$1`**");
          if (index.preview) {
            highlightedContent = `<img src="${index.preview}" alt="Preview" height="150" align="right" />\n\n` + highlightedContent;
          }
          
          // Add loading indicator if content is not fully loaded
          if (!cachedContent && index.contentLength && index.contentLength > 500) {
            highlightedContent += "\n\n*[Click to load full content]*";
          }

          return (
            <List.Item
              key={index.id}
              id={index.id}
              icon={dbMap[index.databaseId || ""]?.icon || (index.typeColor ? { source: Icon.Dot, tintColor: index.typeColor as Color } : Icon.Dot)}
              title={index.name}
              keywords={index.trigger ? [index.trigger] : []}
              accessories={[
                ...(index.type ? [{ tag: { value: index.type, color: index.typeColor as Color } }] : []),
                ...(index.trigger ? [{ tag: { value: index.trigger, color: Color.Blue } }] : [])
              ]}
              detail={
                <List.Item.Detail 
                  markdown={highlightedContent}
                  metadata={
                    showMetadata ? (
                    <List.Item.Detail.Metadata>
                      <List.Item.Detail.Metadata.Label title="Information" />
                      <List.Item.Detail.Metadata.Label title="Name" text={index.name} />
                      {index.type && (
                        <List.Item.Detail.Metadata.TagList title="Type">
                          <List.Item.Detail.Metadata.TagList.Item text={index.type} color={index.typeColor as Color} />
                        </List.Item.Detail.Metadata.TagList>
                      )}
                      {index.status && (
                        <List.Item.Detail.Metadata.TagList title="Status">
                          <List.Item.Detail.Metadata.TagList.Item text={index.status} color={index.statusColor as Color} />
                        </List.Item.Detail.Metadata.TagList>
                      )}
                      {index.trigger && (
                        <List.Item.Detail.Metadata.Label title="Trigger" text={index.trigger} />
                      )}
                      
                      <List.Item.Detail.Metadata.Separator />
                      <List.Item.Detail.Metadata.Label 
                        title="Usage" 
                        text={`${index.usageCount || 0} times`} 
                        icon={Icon.BarChart}
                      />
                      {index.lastUsed && (
                        <List.Item.Detail.Metadata.Label 
                          title="Last Used" 
                          text={new Date(index.lastUsed).toLocaleString()} 
                          icon={Icon.Clock}
                        />
                      )}

                      {placeholders.length > 0 && (
                        <>
                          <List.Item.Detail.Metadata.Separator />
                          <List.Item.Detail.Metadata.Label title="Variables" />
                          {placeholders.map((p) => (
                            <List.Item.Detail.Metadata.Label 
                              key={p} 
                              title={p} 
                              icon={{ source: Icon.Pencil, tintColor: Color.Orange }}
                            />
                          ))}
                        </>
                      )}

                      <List.Item.Detail.Metadata.Separator />
                      <List.Item.Detail.Metadata.Label 
                        title="Source" 
                        text={dbMap[index.databaseId || ""]?.title || "Unknown"} 
                        icon={dbMap[index.databaseId || ""]?.icon}
                      />
                    </List.Item.Detail.Metadata>
                    ) : undefined
                  }
                />
              }
              actions={
                <ActionPanel>
              <ActionPanel.Section>
                <Action title="Paste Snippet" icon={Icon.Clipboard} onAction={() => handleSelect(index)} />
                <Action 
                  title={showMetadata ? "Hide Metadata" : "Show Metadata"}
                  icon={showMetadata ? Icon.EyeDisabled : Icon.Eye}
                  shortcut={{ modifiers: ["cmd", "shift"], key: "d" }}
                  onAction={() => setShowMetadata(!showMetadata)}
                />
                <Action
                  title="Open in Notion"
                  icon={Icon.Link}
                  shortcut={{ modifiers: ["ctrl"], key: "n" }}
                  onAction={() => {
                    if (index.url) {
                      open(index.url);
                    } else {
                      showToast({ style: Toast.Style.Failure, title: "No URL", message: "This snippet doesn't have a Notion URL" });
                    }
                  }}
                />
                <Action
                  title="Edit Snippet"
                  icon={Icon.Pencil}
                  shortcut={{ modifiers: ["cmd"], key: "e" }}
                  onAction={async () => {
                    const content = await loadSnippetContent(index);
                    const fullSnippet = snippetIndexToSnippet(index, content);
                    push(<SnippetForm snippet={fullSnippet} onSuccess={refreshSnippets} />);
                  }}
                />
                <Action
                  title="Create New Snippet"
                  icon={Icon.Plus}
                  shortcut={{ modifiers: ["cmd", "shift"], key: "n" }}
                  onAction={() => push(<SnippetForm onSuccess={refreshSnippets} />)}
                />
              </ActionPanel.Section>
              <ActionPanel.Section title="Sync & Export">
                <Action
                  title="Refresh Sync"
                  icon={Icon.RotateAntiClockwise}
                  shortcut={{ modifiers: ["cmd"], key: "r" }}
                  onAction={refreshSnippets}
                />
                <Action
                  title="Force Full Re-sync"
                  icon={Icon.Warning}
                  shortcut={{ modifiers: ["cmd", "shift"], key: "r" }}
                  onAction={forceReSync}
                />
                <Action
                  title={(selectedIds?.length || 0) > 1 ? `Export ${selectedIds.length} for Global Use` : "Export All for Global Use"}
                  icon={Icon.Download}
                  shortcut={{ modifiers: ["cmd", "shift"], key: "e" }}
                  onAction={exportSelectedAndReveal}
                />
                <Action 
                  title="Copy Raw Content" 
                  icon={Icon.Clipboard}
                  onAction={async () => {
                    const content = await loadSnippetContent(index);
                    await Clipboard.copy(content);
                    showToast({ style: Toast.Style.Success, title: "Content copied" });
                  }}
                />
              </ActionPanel.Section>
            </ActionPanel>
          }
        />
      );
    })}
    </List>
  );
}
