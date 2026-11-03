import { useLocalSearchParams } from 'expo-router';
import React from 'react';
import { ChatComposer } from '@/components/ChatComposer';
import { Hydrated } from '@/components/ui';

export default function ChatScreen() {
  return (
    <Hydrated>
      <Conversation />
    </Hydrated>
  );
}

function Conversation() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <ChatComposer conversationId={id ?? null} showBack />;
}
