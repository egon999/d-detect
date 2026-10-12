import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useState } from 'react';
import { View } from 'react-native';

import {
  Icon,
  Row,
  ScreenScroll,
  SegmentedControl,
  Stack,
  Surface,
  Text,
  useTheme,
  type IconName,
} from '@ui';

type Part = 'records' | 'purpose';

interface Clause {
  icon: IconName;
  heading: string;

  lines: readonly string[];
}

const RECORDS: readonly Clause[] = [
  {
    icon: 'tray-arrow-up',
    heading: 'What you add',
    lines: [
      'Photos and screenshots, bills, receipts, tickets and documents — whatever you choose to put in. Recordings of meetings you make inside the app. Anything you type yourself, like a note or a missing date.',
      'Nothing is collected in the background. The app has no record of anything you did not hand it.',
    ],
  },
  {
    icon: 'text-recognition',
    heading: 'Read on the way in',
    lines: [
      'Each file is read when you add it, and what is written on it — the date, the amount, who it was with, what it was for — is saved beside it on your timeline, so you do not have to type any of it. A meeting is written out in the language it was spoken in.',
      'That reading happens on the server this app talks to, not on your phone, and the server passes the file on to an outside service that does the actual reading — one for pictures, one for sound, depending on what you added. It is the reason a file has to be uploaded before you see any of the details: there is no way to read it without sending it.',
      'The original is kept exactly as you added it. Every detail on your timeline can be traced back to the file it came off, which is also how you check one that looks wrong.',
      'Some of what it writes down is kept as the words themselves — a line it read, or the sentence a speaker said — so that you can see the exact wording rather than a summary of it.',
    ],
  },
  {
    icon: 'database-outline',
    heading: 'Where it is kept',
    lines: [
      'On the server this app connects to, under your account, along with the files themselves. The app signs in as you and asks for your records; it has no way to ask for anyone else’s.',
      'Your records are not sold. They are not handed to advertisers, nothing in them is used to sell you anything, and they are not pooled with other people’s to make a product out of.',
    ],
  },
  {
    icon: 'trash-can-outline',
    heading: 'Getting rid of it',
    lines: [
      'Every entry can be deleted from its own page. Once nothing else needs the file it was read from, the file goes with it rather than being hidden, and there is no second copy kept somewhere else.',
      'The one case where the file stays: if you have attached it to a case, deleting the entry leaves the case’s copy of it in place, because the case still refers to it. That copy goes when you remove it from the case or delete the case.',
      'Deleting your account removes everything kept under it on the server — the entries, the meetings, the files, what was read off them, and the account record itself. Account controls live on your account page.',
      'One thing that deletion cannot reach from here: the Google account you signed in with is Google’s, not this app’s. Deleting your D-Detect account does not close it, and if you signed in with Google you may want to remove D-Detect from that account’s connected apps as well.',
    ],
  },
  {
    icon: 'lock-outline',
    heading: 'Your way in',
    lines: [
      'Your email and password, or your Google account, are how the server knows the records are yours. Keep them to yourself: anyone who can sign in as you can read everything you have kept.',
      'The app never asks you for anything else — no keys, no settings, nothing about the phone itself.',
    ],
  },
];

const PURPOSE: readonly Clause[] = [
  {
    icon: 'notebook-outline',
    heading: 'What it is',
    lines: [
      'A place to keep your own record of what happened. What you paid, what you were charged, what you were given, what was agreed in a meeting — kept in order, in one place, without typing it in.',
      'It is for your own use. You can stop using it whenever you like and take your records out of it by deleting them.',
    ],
  },
  {
    icon: 'magnify',
    heading: 'What can be wrong',
    lines: [
      'A number can be read off a blurred photo incorrectly. A date written in an unusual order can be read the wrong way round. A name can be misspelt the way the document misspelt it.',
      'So anything you are going to rely on, check against the original — which is always kept, on the entry’s own page, for exactly this.',
      'Where the app is unsure, it says so and asks you, rather than filling the gap with a guess.',
    ],
  },
  {
    icon: 'scale-balance',
    heading: 'It does not decide who is right',
    lines: [
      'When you put someone else’s claim next to what you saved, the app shows where the two agree, where they contradict each other, and where there is nothing saved either way. That is all it shows.',
      'It is not a ruling, it is not a score, and it does not tell you that you will win. Reading it and deciding what to do next is yours.',
    ],
  },
  {
    icon: 'information-outline',
    heading: 'It is not advice',
    lines: [
      'Nothing here is legal advice, financial advice or tax advice, and nothing it shows should be treated as a professional opinion. If something matters enough to act on, take the records to someone qualified to advise you — having them in order is what the app is for.',
    ],
  },
  {
    icon: 'file-document-outline',
    heading: 'This page',
    lines: [
      'This is the whole of it. There is no longer document somewhere else, and nothing here is written in a way that needs a lawyer to read it.',
      'If the app ever behaves differently from this page, the page is wrong and should be fixed.',
    ],
  },
];

export default function LegalScreen() {
  const theme = useTheme();
  const router = useRouter();
  const params = useLocalSearchParams<{ part?: string }>();

  const [part, setPart] = useState<Part>(params.part === 'purpose' ? 'purpose' : 'records');

  const clauses = part === 'records' ? RECORDS : PURPOSE;

  return (
    <ScreenScroll
      title={part === 'records' ? 'Your records' : 'What this is for'}
      subtitle={
        part === 'records'
          ? 'What the app keeps, where it keeps it, and how to get rid of it.'
          : 'What D-Detect does, and the three things it will not tell you.'
      }
      back

      onBack={() => {
        if (router.canGoBack()) router.back();
        else router.replace('/sign-in');
      }}
    >
      <View style={{ marginBottom: theme.spacing.xxl }}>
        <SegmentedControl<Part>
          value={part}
          onChange={setPart}
          options={[
            { value: 'records', label: 'Your records' },
            { value: 'purpose', label: 'What it’s for' },
          ]}
        />
      </View>

      <Stack gap="lg">
        {clauses.map((clause) => (
          <Surface key={clause.heading} padding="xl" radius="lg" bordered>
            <Row gap="md" align="center" style={{ marginBottom: theme.spacing.md }}>
              <Icon name={clause.icon} size={20} color={theme.colors.accent} />
              <Text variant="subheading" style={{ flex: 1 }}>
                {clause.heading}
              </Text>
            </Row>

            <Stack gap="md">
              {clause.lines.map((line) => (
                <Text key={line.slice(0, 32)} variant="body" colorToken="textSecondary">
                  {line}
                </Text>
              ))}
            </Stack>
          </Surface>
        ))}
      </Stack>
    </ScreenScroll>
  );
}
