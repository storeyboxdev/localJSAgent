export { dateTime } from "./dateTime.js";
export { readFile } from "./readFile.js";
export { writeFile } from "./writeFile.js";
export { deleteFile } from "./deleteFile.js";
export { listFiles } from "./listFiles.js";
export { changeDirectory } from "./changeDirectory.js";
export { currentDirectory } from "./currentDirectory.js";
export { listCalendars, setActiveCalendar, listEvents, addEvent, editEvent, deleteEvent } from "./gcalendar.js";
export { calendar, activeCalendar, TIMEZONE } from "./gcalendar.js";

import { dateTime } from "./dateTime.js";
import { readFile } from "./readFile.js";
import { writeFile } from "./writeFile.js";
import { deleteFile } from "./deleteFile.js";
import { listFiles } from "./listFiles.js";
import { changeDirectory } from "./changeDirectory.js";
import { currentDirectory } from "./currentDirectory.js";
import { listCalendars, setActiveCalendar, listEvents, addEvent, editEvent, deleteEvent } from "./gcalendar.js";

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
};
