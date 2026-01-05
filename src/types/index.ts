export interface Snippet {
  id: string;
  name: string;
  content: string;
  trigger?: string;
  description?: string;
  sourceDb?: string;
  databaseId?: string;
  preview?: string;
  usageCount?: number;
  lastUsed?: string;
  url?: string;
  type?: string;
  typeColor?: string;
  status?: string;
  statusColor?: string;
}

export interface Preferences {
  notionToken: string;
  databaseIds: string;
  showMetadata: boolean;
}
