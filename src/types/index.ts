export interface Snippet {
  id: string;
  name: string;
  content: string;
  trigger?: string;
  description?: string;
  sourceDb?: string;
}

export interface Preferences {
  notionToken: string;
  databaseIds: string;
}
