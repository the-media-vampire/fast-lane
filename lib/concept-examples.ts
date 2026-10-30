import type { StoryBeat } from "./types";

/** Preview copy for saved demo directions; production plans and films stay unchanged. */
export const EXAMPLE_STORIES: Record<string, StoryBeat[]> = {
  "The Last Turn": [
    { title: "The opening", visual: "In the quiet shop, the mechanic tests the bell on a red bike.", lines: [] },
    { title: "A little care", visual: "Oil reaches the chain and the mechanic makes one final adjustment.", lines: [{ kind: "vo", text: "Bring it in before spring arrives." }] },
    { title: "The handover", visual: "The customer arrives; the mechanic rolls over her bike and they exchange a nod.", lines: [] },
    { title: "The first ride", visual: "She wheels outside, climbs on and rides along the quiet spring street.", lines: [] },
    { title: "The invitation", visual: "She rides into the morning light as the shop's invitation appears.", lines: [{ kind: "super", text: "Ride into spring." }, { kind: "super", text: "Spoke & Sprocket" }] },
  ],
  "Out of Hibernation": [
    { title: "Winter sleep", visual: "A forgotten bike waits in the hallway with a flat tyre, a dry chain and a dull bell.", lines: [] },
    { title: "Time to wake", visual: "Its owner takes it out of the hallway and into the bike shop.", lines: [] },
    { title: "Coming alive", visual: "The mechanic pumps the tyre, oils the chain and brings back the bell's clear ring.", lines: [] },
    { title: "Back outside", visual: "The customer collects the restored bike and rides into the spring morning.", lines: [] },
    { title: "The invitation", visual: "The bell rings once against birdsong as the shop's invitation appears.", lines: [{ kind: "super", text: "Ride into spring." }, { kind: "super", text: "Spoke & Sprocket" }] },
  ],
  "Sound Check": [
    { title: "One clear note", visual: "A bell rings in darkness; light reveals the mechanic's thumb resting beside it.", lines: [] },
    { title: "The rhythm", visual: "A wrench, a pump and a spinning wheel each add their own small sound.", lines: [] },
    { title: "The arrival", visual: "The customer's footsteps join the rhythm as the mechanic brings over the bike.", lines: [] },
    { title: "Into morning", visual: "Soft guitar joins as the rider glides outside, the freewheel ticking beneath birdsong.", lines: [] },
    { title: "The invitation", visual: "The sounds fade into a quiet morning and the shop's closing invitation.", lines: [{ kind: "super", text: "Ride into spring." }, { kind: "super", text: "Spoke & Sprocket" }] },
  ],
  "The Packet Passed": [
    { title: "The discovery", visual: "Ruth finds a seed packet labelled for Claire, then closes the tin and puts it away.", lines: [{ kind: "super", text: "For Claire – runner beans." }, { kind: "super", text: "She never waited for them." }] },
    { title: "The distance", visual: "Claire clears dead stems outside while Ruth tidies the shed; neither approaches the other.", lines: [] },
    { title: "Her own packet", visual: "Ruth opens the tin again and finds a second packet with a note for her.", lines: [{ kind: "super", text: "For Ruth – sweet peas." }, { kind: "super", text: "She liked the smell." }] },
    { title: "The crossing", visual: "Ruth walks out with both packets and offers Claire the one with her name.", lines: [{ kind: "dialogue", speaker: "Ruth", text: "He labelled them." }] },
    { title: "The memory", visual: "Claire reads the note, softens and looks down at the row she has cleared.", lines: [{ kind: "dialogue", speaker: "Claire", text: "I always picked them too soon." }] },
    { title: "Together", visual: "The sisters kneel side by side and plant into the same row as the morning warms.", lines: [{ kind: "dialogue", speaker: "Ruth", text: "Not so deep." }, { kind: "super", text: "Labelled Seeds" }] },
  ],
  "Two Gates": [
    { title: "An arrival", visual: "Claire is already working when Ruth opens the gate; Claire hears her but does not turn.", lines: [] },
    { title: "Separate corners", visual: "One sister bags old netting while the other coils a hose at the far end of the plot.", lines: [] },
    { title: "The meeting", visual: "They reach the shed together and pause at the same bench.", lines: [{ kind: "dialogue", speaker: "Ruth", text: "There’s one for each of us." }] },
    { title: "Two memories", visual: "They open the tin and read the notes on the packets he left for them.", lines: [{ kind: "super", text: "For Claire – runner beans." }, { kind: "super", text: "For Ruth – sweet peas." }] },
    { title: "A shared row", visual: "The sisters carry each other's packets outside and kneel together to plant.", lines: [{ kind: "super", text: "Labelled Seeds" }] },
  ],
  "One Fixed Frame": [
    { title: "The same space", visual: "A sister steps beside the shed, notices someone nearby and quietly walks away.", lines: [] },
    { title: "Almost meeting", visual: "The sisters cross the same garden without looking at each other, once passing within arm's reach.", lines: [] },
    { title: "The tin", visual: "One sister sets the red tin on the cold frame and lifts its lid.", lines: [] },
    { title: "The notes", visual: "We come close for the first time as both sisters read their names in his handwriting.", lines: [{ kind: "super", text: "For Claire – runner beans." }, { kind: "super", text: "For Ruth – sweet peas." }] },
    { title: "A changed picture", visual: "We return to the original view; both sisters now kneel in the row they had been avoiding.", lines: [{ kind: "super", text: "Labelled Seeds" }] },
  ],
  "The quiet hour": [
    { title: "Step inside", visual: "Mara leaves the busy street and closes the café door behind her.", lines: [] },
    { title: "The ritual", visual: "Coffee pours, steam rises and a warm cup is placed on the counter.", lines: [{ kind: "super", text: "A little space in your day" }] },
    { title: "A quiet minute", visual: "Mara settles by the window, watches the street and allows herself a small smile.", lines: [{ kind: "vo", text: "Make a little room for yourself." }] },
    { title: "The invitation", visual: "Her cup rests on the table as the café's closing invitation appears.", lines: [{ kind: "super", text: "Make room." }, { kind: "super", text: "[brand line]" }] },
  ],
  "Made with care": [
    { title: "The first pour", visual: "Steam catches the window light as the first coffee pours into a cream cup.", lines: [] },
    { title: "Small rituals", visual: "Hands measure, pour and wipe the walnut counter, giving each simple gesture room.", lines: [] },
    { title: "The finished cup", visual: "The cup is placed in front of Mara; she wraps her hands around it.", lines: [] },
    { title: "The first sip", visual: "Mara tastes the coffee, pauses and smiles as the invitation appears.", lines: [{ kind: "super", text: "Made with care." }, { kind: "super", text: "[brand line]" }] },
  ],
  "A small connection": [
    { title: "The last table", visual: "Mara and another customer reach the last window table at the same time.", lines: [] },
    { title: "A hesitation", visual: "Both stop, gesture for the other to sit and share an embarrassed smile.", lines: [] },
    { title: "Making room", visual: "Mara moves a chair and makes space for the other customer's cup.", lines: [] },
    { title: "A little warmth", visual: "They sit together by the window as the café's invitation appears.", lines: [{ kind: "super", text: "Make room." }, { kind: "super", text: "[brand line]" }] },
  ],
};
