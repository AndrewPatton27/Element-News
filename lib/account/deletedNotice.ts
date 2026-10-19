// Wording for the "it's gone" confirmation shown after a delete (components/account/DeletedNotice.tsx).
// Pure: no React, no storage.

export type DeletedKind = 'account' | 'data' | 'device';

export interface DeletedContent {
  title: string;
  body: string;
  button: string;
  label: string; // accessible name of the dialog
}

const BUTTON = 'Back to the feed';

export function deletedContent(kind: DeletedKind): DeletedContent {
  switch (kind) {
    case 'account':
      return {
        title: 'Your account and data have been deleted',
        body: 'Your login, topics and history are gone, and this device has forgotten your choices too.',
        button: BUTTON,
        label: 'Account deleted',
      };
    case 'data':
      return {
        title: 'Your data has been deleted',
        body: 'Your topics and history are gone. Your login is still here.',
        button: BUTTON,
        label: 'Data deleted',
      };
    case 'device':
      return {
        title: 'This device’s data has been deleted',
        body: 'This device has forgotten your likes, topics, followed companies, searches and history. An account, if you have one, is untouched.',
        button: BUTTON,
        label: 'Device data deleted',
      };
  }
}

/** Where the button goes. */
export const DELETED_HOME = '/';
