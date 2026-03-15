export { dateTime } from "./dateTime.js";
export { readFile } from "./readFile.js";
export { writeFile } from "./writeFile.js";
export { deleteFile } from "./deleteFile.js";
export { listFiles } from "./listFiles.js";
export { changeDirectory } from "./changeDirectory.js";
export { currentDirectory } from "./currentDirectory.js";
export { listCalendars, setActiveCalendar, listEvents, addEvent, editEvent, deleteEvent } from "./gcalendar.js";
export { calendar, activeCalendar, TIMEZONE } from "./gcalendar.js";
export { searchEmails, readEmail, sendEmail, replyToEmail, forwardEmail, trashEmail, archiveEmail, markAsRead } from "./gmail.js";
export { renderTab } from "./renderTab.js";
export { renderScore } from "./renderScore.js";
export { resolveScale } from "./resolveScale.js";
export { resolveChord } from "./resolveChord.js";
export { createTask, listTasks, updateTask, completeTask, deleteTask } from "./taskManager.js";
export { listMidiTracks, extractMidiTrack } from "./midi.js";

import { dateTime } from "./dateTime.js";
import { readFile } from "./readFile.js";
import { writeFile } from "./writeFile.js";
import { deleteFile } from "./deleteFile.js";
import { listFiles } from "./listFiles.js";
import { changeDirectory } from "./changeDirectory.js";
import { currentDirectory } from "./currentDirectory.js";
import { listCalendars, setActiveCalendar, listEvents, addEvent, editEvent, deleteEvent } from "./gcalendar.js";
import { searchEmails, readEmail, sendEmail, replyToEmail, forwardEmail, trashEmail, archiveEmail, markAsRead } from "./gmail.js";
import { renderTab } from "./renderTab.js";
import { renderScore } from "./renderScore.js";
import { resolveScale } from "./resolveScale.js";
import { resolveChord } from "./resolveChord.js";
import { createTask, listTasks, updateTask, completeTask, deleteTask } from "./taskManager.js";
import { listMidiTracks, extractMidiTrack } from "./midi.js";

export const tools = {
  dateTime,
  readFile,
  writeFile,
  deleteFile,
  listFiles,
  changeDirectory,
  currentDirectory,
  listCalendars,
  setActiveCalendar,
  listEvents,
  addEvent,
  editEvent,
  deleteEvent,
  searchEmails,
  readEmail,
  sendEmail,
  replyToEmail,
  forwardEmail,
  trashEmail,
  archiveEmail,
  markAsRead,
  renderTab,
  renderScore,
  resolveScale,
  resolveChord,
  createTask,
  listTasks,
  updateTask,
  completeTask,
  deleteTask,
  listMidiTracks,
  extractMidiTrack,
};
