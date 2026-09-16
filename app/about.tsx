import React from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FadeIn, ScreenHeaderBar, SlideUpIn, Surface, Text, useTheme } from '@ui';

const steps = [
  ['Start with a question', 'Create a case and write the claims you want to check. Add the people involved when you know who they are. A claim is a statement to examine, not a fact the app assumes is true.'],
  ['Add the sources', 'Upload original screenshots, documents or recordings, or add a written account. Label where each source came from. Keep the original context when possible; a cropped message may leave out something important.'],
  ['Review what was read', 'Check the extracted text against the original. Image reading and speech transcription can make mistakes. Processing status tells you which sources are ready, which failed, and which need attention.'],
  ['Compare the claims', 'Run analysis to compare processed sources in the case. Each assessed claim shows its conclusion, relevant quoted evidence, missing information and limitations. Open a citation to inspect the source yourself.'],
  ['Follow the connections', 'Use the evidence graph to explore which sources support or conflict with a claim. Return to the underlying evidence when a relationship needs closer review. Your case history and search help you find the work later.'],
] as const;

const outcomes = [
  ['Supported', 'The supplied evidence supports the claim, within the limitations shown.'],
  ['Partially supported', 'Evidence supports part of the claim, while other parts remain uncertain.'],
  ['Contradicted', 'Relevant supplied evidence conflicts with the claim. This does not establish intent to deceive.'],
  ['Disputed', 'The case contains both supporting and conflicting evidence.'],
  ['Insufficient evidence', 'The available sources do not provide enough information to assess the claim.'],
  ['Unresolved', 'A conclusion cannot be reached from the available evidence and context.'],
] as const;

export default function AboutScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.fill, { backgroundColor: theme.colors.canvas }]}>
      <ScrollView contentContainerStyle={{ paddingHorizontal: theme.layout.screenPadding, paddingTop: insets.top + theme.layout.headerHeight + theme.spacing.lg, paddingBottom: insets.bottom + theme.spacing.xl }}>
        <View style={styles.content}>
          <SlideUpIn>
            <Text variant="display">Review evidence. Understand the uncertainty.</Text>
          </SlideUpIn>
          <SlideUpIn delay={theme.motion.stagger}>
            <Text colorToken="textSecondary" style={{ marginTop: theme.spacing.md }}>Ddetect helps you examine claims using the sources you provide. It organizes evidence and explains what an analysis rests on, so you can review the conclusion yourself.</Text>
          </SlideUpIn>
          <SlideUpIn delay={theme.motion.stagger * 2}>
            <View style={{ marginTop: theme.spacing.xl, gap: theme.spacing.lg }}>
              {steps.map(([title, body], index) => (
                <Surface key={title} padding="lg" radius="lg">
                  <Text variant="caption" colorToken="textSecondary">Step {index + 1}</Text>
                  <Text variant="title" style={{ marginTop: theme.spacing.xs }}>{title}</Text>
                  <Text colorToken="textSecondary" style={{ marginTop: theme.spacing.sm }}>{body}</Text>
                </Surface>
              ))}
            </View>
          </SlideUpIn>
          {/* Below the fold on a phone, so it fades as one block rather than cascading: a
              stagger nobody has scrolled to yet is motion spent where no one is looking. */}
          <FadeIn delay={theme.motion.stagger * 3}>
            <Text variant="title" style={{ marginTop: theme.spacing.xl }}>What a conclusion means</Text>
            <View style={{ marginTop: theme.spacing.md, gap: theme.spacing.md }}>
              {outcomes.map(([title, body]) => <View key={title}><Text variant="subheading">{title}</Text><Text colorToken="textSecondary" style={{ marginTop: theme.spacing.xs }}>{body}</Text></View>)}
            </View>
            <Surface padding="lg" radius="lg" style={{ marginTop: theme.spacing.xl }}>
              <Text variant="title">What to check before relying on a result</Text>
              <Text colorToken="textSecondary" style={{ marginTop: theme.spacing.sm }}>A quote shows where an assessment came from. It does not prove that a source is authentic or that the interpretation is correct. An edited screenshot, missing messages or an inaccurate transcript can change the picture.</Text>
              <Text colorToken="textSecondary" style={{ marginTop: theme.spacing.md }}>Review the coverage and limitations. PDF reading includes a limited number of scanned pages; add excluded or unreadable pages separately when needed. Recording analysis currently reads speech; it does not verify speaker identity or interpret video frames. Large sources may be only partially processed.</Text>
              <Text colorToken="textSecondary" style={{ marginTop: theme.spacing.md }}>An analysis is evidence review assistance, not a legal judgment or a guarantee of truth.</Text>

              {/*
                This paragraph used to say content was "sent to the platform's analysis
                service when you request processing". There is no such service — the app is
                local-first and no backend of ours ever receives evidence — so the sentence
                described an architecture that does not exist. A privacy disclosure that is
                wrong in the developer's favour is the worst kind of wrong, so it now names
                what actually happens.

                It took three attempts to get this sentence true, which is the point of
                writing it out here. Attempt one said reading and transcribing are both
                on-device — false for audio, which needs the provider. Attempt two said
                reading is on-device — false for images in part, because while ML Kit does
                the recognition locally, the recognised text is then sent to a model to be
                organised (`multimodal-extractor.ts:108`: that model pass is optional and
                the on-device text is kept when it fails). What survives is the version
                below, which separates recognition from what is sent and names both actions
                that leave the device.

                Kept to "the provider you configure" rather than naming Groq: what a reader
                needs is that the destination is one they chose and can revoke by removing
                the key, not the vendor's name. Settings is where a key is added or removed.
              */}
              <Text colorToken="textSecondary" style={{ marginTop: theme.spacing.md }}>By default everything stays on this device. If you sign in, your cases are stored in your own account so they are available on your other devices. Documents, images and recordings are read on the device. Two things need the provider you configure in Settings, with your own key, and neither happens without it: a recording is sent to be transcribed, and text that has been read is sent to be organised into dates, amounts and names. Remove the key and both stop; the text already read on the device is kept either way. Keep sensitive details limited to what the case needs.</Text>
            </Surface>
          </FadeIn>
        </View>
      </ScrollView>
      <ScreenHeaderBar title="How evidence review works" back />
    </View>
  );
}

const styles = StyleSheet.create({ fill: { flex: 1 }, content: { width: '100%', maxWidth: 820, alignSelf: 'center' } });
