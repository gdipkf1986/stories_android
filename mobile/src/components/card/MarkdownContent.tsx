import Markdown, { MarkdownIt, type MarkdownParser } from '@ronradtke/react-native-markdown-display';
import { Linking, StyleSheet } from 'react-native';

const markdownIt = new MarkdownIt({ html: true, typographer: true }) as unknown as MarkdownParser;

const styles = StyleSheet.create({
  body: {
    fontSize: 14,
    color: '#333333',
  },
  heading1: {
    fontSize: 22,
    fontWeight: '600',
    color: '#121212',
    marginTop: 12,
    marginBottom: 6,
  },
  heading2: {
    fontSize: 19,
    fontWeight: '600',
    color: '#121212',
    marginTop: 12,
    marginBottom: 6,
  },
  heading3: {
    fontSize: 16,
    fontWeight: '600',
    color: '#121212',
    marginTop: 10,
    marginBottom: 5,
  },
  heading4: {
    fontSize: 15,
    fontWeight: '600',
    color: '#121212',
    marginTop: 10,
    marginBottom: 5,
  },
  heading5: {
    fontSize: 14,
    fontWeight: '600',
    color: '#121212',
    marginTop: 8,
    marginBottom: 4,
  },
  heading6: {
    fontSize: 14,
    fontWeight: '500',
    color: '#333333',
    marginTop: 8,
    marginBottom: 4,
  },
  paragraph: {
    marginTop: 0,
    marginBottom: 10,
    lineHeight: 23,
  },
  blockquote: {
    backgroundColor: '#f6f7f9',
    borderLeftColor: '#d0d7de',
    borderLeftWidth: 3,
    marginLeft: 0,
    paddingVertical: 4,
    paddingHorizontal: 8,
    marginBottom: 10,
  },
  code_inline: {
    borderWidth: 0,
    backgroundColor: '#f0f1f3',
    paddingVertical: 1,
    paddingHorizontal: 4,
    borderRadius: 4,
    fontSize: 13,
    color: '#cf222e',
  },
  code_block: {
    borderWidth: 0,
    backgroundColor: '#f6f7f9',
    padding: 10,
    borderRadius: 6,
    fontSize: 12,
    lineHeight: 18,
    color: '#24292f',
  },
  fence: {
    borderWidth: 0,
    borderColor: 'transparent',
    backgroundColor: '#f6f7f9',
    borderRadius: 6,
    marginBottom: 10,
    overflow: 'hidden',
  },
  fence_code: {
    backgroundColor: '#f6f7f9',
    padding: 10,
  },
  fence_token: {
    fontSize: 12,
    lineHeight: 18,
    color: '#24292f',
  },
  link: {
    color: '#0969da',
    textDecorationLine: 'underline',
    marginBottom: 0,
  },
  image: {
    maxWidth: '100%',
    marginBottom: 8,
  },
  hr: {
    backgroundColor: '#e3e6ea',
    height: 1,
    marginVertical: 10,
  },
  table: {
    borderColor: '#e3e6ea',
    borderRadius: 4,
    marginBottom: 10,
  },
  tr: {
    borderColor: '#e3e6ea',
  },
  th: {
    fontSize: 13,
    fontWeight: '600',
    padding: 6,
  },
  td: {
    fontSize: 13,
    lineHeight: 19,
    padding: 6,
  },
});

export function MarkdownContent({ content }: { content: string }) {
  return (
    <Markdown
      markdownit={markdownIt}
      style={styles}
      onLinkPress={() => true}
    >
      {content}
    </Markdown>
  );
}
