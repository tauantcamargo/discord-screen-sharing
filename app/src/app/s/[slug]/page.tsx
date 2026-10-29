import { notFound } from "next/navigation";

import { Room } from "@/components/room";

/**
 * Sala de link fixo: `/s/<nome>`.
 *
 * Um endereço estável para fixar num canal do Discord — a voz fica na call, e
 * a tela abre aqui, no navegador. Quem abre cai direto na sala, sem lobby; a
 * sala não aparece na lista pública.
 */
export default async function FixedRoomPage({ params }: PageProps<"/s/[slug]">) {
  const { slug } = await params;
  if (!/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(slug)) notFound();
  return <Room fixa={slug} />;
}
