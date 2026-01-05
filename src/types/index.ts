export interface Snippet {
  id: string;
  name: string;
  content: string;
  trigger?: string;
  description?: string;
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

export interface DatabaseMetadata {
  id: string;
  title: string;
  icon?: string;
}

export interface Preferences {
  notionToken: string;
  databaseIds: string;
  showMetadata: boolean;
}
