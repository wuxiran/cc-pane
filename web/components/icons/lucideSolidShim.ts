// 由 lucide-react 的别名指向本文件（vite.config.ts / vitest.config.ts）：全应用仍写
// `import { X } from "lucide-react"`，渲染出来是 Phosphor 的统一实心款。
// 表外的 lucide 图标原样透出（线框），新用到的图标要统一就在下面补一行。
//
// 每行：lucide 名 = solid(Phosphor 图标, 粗细, lucide 原本的 class, 显示名)。
// 粗细：有面积的用 fill（实心）；纯笔画字形（箭头/勾/叉/加减/chevron/点阵/转圈）用 bold，
// 它们填了也还是线，bold 与 fill 笔画同重，放一起是一套。Circle / Square 本身就是
// 「空」的语义（未完成的待办、最大化按钮），默认 bold 空心，要实心由调用方传 fill。
// lucide 原 class 保留，测试与样式里按 .lucide-x 之类找图标的地方不受影响。
/* eslint-disable react-refresh/only-export-components */
import { solid } from "./solidIconFactory";
import {
  Archive as PhArchive, ArrowCircleUp as PhArrowCircleUp, ArrowClockwise as PhArrowClockwise,
  ArrowCounterClockwise as PhArrowCounterClockwise, ArrowDown as PhArrowDown,
  ArrowDownLeft as PhArrowDownLeft, ArrowLeft as PhArrowLeft, ArrowLineDown as PhArrowLineDown,
  ArrowLineUp as PhArrowLineUp, ArrowRight as PhArrowRight, ArrowSquareIn as PhArrowSquareIn,
  ArrowSquareOut as PhArrowSquareOut, ArrowUUpLeft as PhArrowUUpLeft, ArrowUUpRight as PhArrowUUpRight,
  ArrowUp as PhArrowUp, ArrowUpRight as PhArrowUpRight, ArrowsClockwise as PhArrowsClockwise,
  ArrowsDownUp as PhArrowsDownUp, ArrowsInLineVertical as PhArrowsInLineVertical,
  ArrowsInSimple as PhArrowsInSimple, ArrowsOut as PhArrowsOut, ArrowsOutCardinal as PhArrowsOutCardinal,
  ArrowsOutSimple as PhArrowsOutSimple, Bell as PhBell, BellSlash as PhBellSlash, BookOpen as PhBookOpen,
  BookmarkSimple as PhBookmarkSimple, Books as PhBooks, BoxArrowUp as PhBoxArrowUp,
  BracketsCurly as PhBracketsCurly, Brain as PhBrain, Browser as PhBrowser, CalendarBlank as PhCalendarBlank,
  CalendarDots as PhCalendarDots, CalendarX as PhCalendarX, Camera as PhCamera, CaretDown as PhCaretDown,
  CaretLeft as PhCaretLeft, CaretRight as PhCaretRight, CaretUp as PhCaretUp, CaretUpDown as PhCaretUpDown,
  ChartBar as PhChartBar, Chat as PhChat, ChatCenteredDots as PhChatCenteredDots, ChatCircle as PhChatCircle,
  ChatText as PhChatText, Chats as PhChats, Check as PhCheck, CheckCircle as PhCheckCircle,
  CheckSquare as PhCheckSquare, Circle as PhCircle, CircleDashed as PhCircleDashed,
  CircleNotch as PhCircleNotch, Clipboard as PhClipboard, ClipboardText as PhClipboardText, Clock as PhClock,
  ClockCounterClockwise as PhClockCounterClockwise, Cloud as PhCloud, CloudArrowUp as PhCloudArrowUp,
  Code as PhCode, CodeSimple as PhCodeSimple, Columns as PhColumns, Command as PhCommand,
  Compass as PhCompass, Copy as PhCopy, CopySimple as PhCopySimple, Cpu as PhCpu, Crosshair as PhCrosshair,
  Cube as PhCube, Cursor as PhCursor, Database as PhDatabase, Desktop as PhDesktop, Devices as PhDevices,
  Diamond as PhDiamond, DotsNine as PhDotsNine, DotsSix as PhDotsSix, DotsSixVertical as PhDotsSixVertical,
  DotsThree as PhDotsThree, DownloadSimple as PhDownloadSimple, Equals as PhEquals, Eraser as PhEraser,
  Eye as PhEye, EyeSlash as PhEyeSlash, File as PhFile, FileArrowDown as PhFileArrowDown,
  FileArrowUp as PhFileArrowUp, FileCode as PhFileCode, FilePlus as PhFilePlus, FileText as PhFileText,
  Files as PhFiles, FilmSlate as PhFilmSlate, Flag as PhFlag, Flask as PhFlask, FloppyDisk as PhFloppyDisk,
  FlowArrow as PhFlowArrow, Folder as PhFolder, FolderMinus as PhFolderMinus, FolderOpen as PhFolderOpen,
  FolderPlus as PhFolderPlus, FolderSimple as PhFolderSimple, Footprints as PhFootprints, Funnel as PhFunnel,
  Gauge as PhGauge, Gear as PhGear, GitBranch as PhGitBranch, GitCommit as PhGitCommit, GitDiff as PhGitDiff,
  GitFork as PhGitFork, GitMerge as PhGitMerge, Globe as PhGlobe,
  GlobeHemisphereWest as PhGlobeHemisphereWest, GraduationCap as PhGraduationCap, Hand as PhHand,
  HardDrive as PhHardDrive, HardDrives as PhHardDrives, Hash as PhHash, House as PhHouse,
  IdentificationBadge as PhIdentificationBadge, Image as PhImage, Info as PhInfo, Kanban as PhKanban,
  Key as PhKey, Keyboard as PhKeyboard, Laptop as PhLaptop, Layout as PhLayout, Lightning as PhLightning,
  Link as PhLink, LinkBreak as PhLinkBreak, LinkSimple as PhLinkSimple, List as PhList,
  ListChecks as PhListChecks, ListNumbers as PhListNumbers, ListPlus as PhListPlus, Lock as PhLock,
  LockKey as PhLockKey, MagicWand as PhMagicWand, MagnifyingGlass as PhMagnifyingGlass,
  MagnifyingGlassMinus as PhMagnifyingGlassMinus, MagnifyingGlassPlus as PhMagnifyingGlassPlus,
  MapPin as PhMapPin, Microphone as PhMicrophone, MicrophoneSlash as PhMicrophoneSlash, Minus as PhMinus,
  MinusCircle as PhMinusCircle, Monitor as PhMonitor, MusicNote as PhMusicNote, MusicNotes as PhMusicNotes,
  NotePencil as PhNotePencil, Package as PhPackage, Palette as PhPalette,
  PaperPlaneRight as PhPaperPlaneRight, PaperPlaneTilt as PhPaperPlaneTilt, Pause as PhPause,
  PencilLine as PhPencilLine, PencilSimple as PhPencilSimple, PictureInPicture as PhPictureInPicture,
  Play as PhPlay, Plugs as PhPlugs, Plus as PhPlus, Power as PhPower, PushPin as PhPushPin,
  PushPinSlash as PhPushPinSlash, Question as PhQuestion, Radio as PhRadio, Repeat as PhRepeat,
  Robot as PhRobot, Rocket as PhRocket, Rows as PhRows, Ruler as PhRuler, Scan as PhScan,
  SealCheck as PhSealCheck, Selection as PhSelection, Shield as PhShield, ShieldCheck as PhShieldCheck,
  ShieldWarning as PhShieldWarning, Shuffle as PhShuffle, Sidebar as PhSidebar,
  SidebarSimple as PhSidebarSimple, SignOut as PhSignOut, SlidersHorizontal as PhSlidersHorizontal,
  Sparkle as PhSparkle, Square as PhSquare, SquareHalf as PhSquareHalf,
  SquareHalfBottom as PhSquareHalfBottom, SquaresFour as PhSquaresFour, Stack as PhStack, Star as PhStar,
  Sun as PhSun, Tag as PhTag, Target as PhTarget, Terminal as PhTerminal, TerminalWindow as PhTerminalWindow,
  TextAlignLeft as PhTextAlignLeft, TextH as PhTextH, Trash as PhTrash, Tray as PhTray,
  TreeStructure as PhTreeStructure, TreeView as PhTreeView, Triangle as PhTriangle, User as PhUser,
  Warning as PhWarning, WarningCircle as PhWarningCircle, WifiHigh as PhWifiHigh, WifiSlash as PhWifiSlash,
  Wrench as PhWrench, X as PhX, XCircle as PhXCircle,
} from "@phosphor-icons/react";

export * from "lucide-react/dist/esm/lucide-react.js";

export const AlertCircle = solid(PhWarningCircle, "fill", "lucide-circle-alert", "AlertCircle");
export const AlertTriangle = solid(PhWarning, "fill", "lucide-triangle-alert", "AlertTriangle");
export const Archive = solid(PhArchive, "fill", "lucide-archive", "Archive");
export const ArchiveRestore = solid(PhBoxArrowUp, "fill", "lucide-archive-restore", "ArchiveRestore");
export const ArrowDown = solid(PhArrowDown, "bold", "lucide-arrow-down", "ArrowDown");
export const ArrowDownLeft = solid(PhArrowDownLeft, "bold", "lucide-arrow-down-left", "ArrowDownLeft");
export const ArrowDownToLine = solid(PhArrowLineDown, "bold", "lucide-arrow-down-to-line", "ArrowDownToLine");
export const ArrowDownUp = solid(PhArrowsDownUp, "bold", "lucide-arrow-down-up", "ArrowDownUp");
export const ArrowLeft = solid(PhArrowLeft, "bold", "lucide-arrow-left", "ArrowLeft");
export const ArrowRight = solid(PhArrowRight, "bold", "lucide-arrow-right", "ArrowRight");
export const ArrowUp = solid(PhArrowUp, "bold", "lucide-arrow-up", "ArrowUp");
export const ArrowUpCircle = solid(PhArrowCircleUp, "fill", "lucide-circle-arrow-up", "ArrowUpCircle");
export const ArrowUpFromLine = solid(PhArrowLineUp, "bold", "lucide-arrow-up-from-line", "ArrowUpFromLine");
export const ArrowUpRight = solid(PhArrowUpRight, "bold", "lucide-arrow-up-right", "ArrowUpRight");
export const BadgeCheck = solid(PhSealCheck, "fill", "lucide-badge-check", "BadgeCheck");
export const BarChart3 = solid(PhChartBar, "fill", "lucide-chart-column", "BarChart3");
export const Bell = solid(PhBell, "fill", "lucide-bell", "Bell");
export const BellOff = solid(PhBellSlash, "fill", "lucide-bell-off", "BellOff");
export const Bookmark = solid(PhBookmarkSimple, "fill", "lucide-bookmark", "Bookmark");
export const BookmarkPlus = solid(PhBookmarkSimple, "fill", "lucide-bookmark-plus", "BookmarkPlus");
export const BookOpen = solid(PhBookOpen, "fill", "lucide-book-open", "BookOpen");
export const Bot = solid(PhRobot, "fill", "lucide-bot", "Bot");
export const Boxes = solid(PhCube, "fill", "lucide-boxes", "Boxes");
export const Brain = solid(PhBrain, "fill", "lucide-brain", "Brain");
export const BrainCircuit = solid(PhBrain, "fill", "lucide-brain-circuit", "BrainCircuit");
export const Cable = solid(PhPlugs, "fill", "lucide-cable", "Cable");
export const Calendar = solid(PhCalendarBlank, "fill", "lucide-calendar", "Calendar");
export const CalendarDays = solid(PhCalendarDots, "fill", "lucide-calendar-days", "CalendarDays");
export const CalendarX2 = solid(PhCalendarX, "fill", "lucide-calendar-x2 lucide-calendar-x-2", "CalendarX2");
export const Camera = solid(PhCamera, "fill", "lucide-camera", "Camera");
export const Check = solid(PhCheck, "bold", "lucide-check", "Check");
export const CheckCircle = solid(PhCheckCircle, "fill", "lucide-circle-check-big", "CheckCircle");
export const CheckCircle2 = solid(PhCheckCircle, "fill", "lucide-circle-check", "CheckCircle2");
export const CheckIcon = solid(PhCheck, "bold", "lucide-check", "CheckIcon");
export const CheckSquare = solid(PhCheckSquare, "fill", "lucide-square-check-big", "CheckSquare");
export const ChevronDown = solid(PhCaretDown, "bold", "lucide-chevron-down", "ChevronDown");
export const ChevronDownIcon = solid(PhCaretDown, "bold", "lucide-chevron-down", "ChevronDownIcon");
export const ChevronLeft = solid(PhCaretLeft, "bold", "lucide-chevron-left", "ChevronLeft");
export const ChevronRight = solid(PhCaretRight, "bold", "lucide-chevron-right", "ChevronRight");
export const ChevronRightIcon = solid(PhCaretRight, "bold", "lucide-chevron-right", "ChevronRightIcon");
export const ChevronsDownUp = solid(PhArrowsInLineVertical, "bold", "lucide-chevrons-down-up", "ChevronsDownUp");
export const ChevronsUpDown = solid(PhCaretUpDown, "bold", "lucide-chevrons-up-down", "ChevronsUpDown");
export const ChevronUp = solid(PhCaretUp, "bold", "lucide-chevron-up", "ChevronUp");
export const ChevronUpIcon = solid(PhCaretUp, "bold", "lucide-chevron-up", "ChevronUpIcon");
export const Circle = solid(PhCircle, "bold", "lucide-circle", "Circle");
export const CircleAlert = solid(PhWarningCircle, "fill", "lucide-circle-alert", "CircleAlert");
export const CircleDashed = solid(PhCircleDashed, "bold", "lucide-circle-dashed", "CircleDashed");
export const CircleHelp = solid(PhQuestion, "fill", "lucide-circle-question-mark", "CircleHelp");
export const CircleIcon = solid(PhCircle, "bold", "lucide-circle", "CircleIcon");
export const CircleX = solid(PhXCircle, "fill", "lucide-circle-x", "CircleX");
export const Clapperboard = solid(PhFilmSlate, "fill", "lucide-clapperboard", "Clapperboard");
export const Clipboard = solid(PhClipboard, "fill", "lucide-clipboard", "Clipboard");
export const ClipboardCopy = solid(PhClipboardText, "fill", "lucide-clipboard-copy", "ClipboardCopy");
export const ClipboardPaste = solid(PhClipboard, "fill", "lucide-clipboard-paste", "ClipboardPaste");
export const Clock = solid(PhClock, "fill", "lucide-clock", "Clock");
export const Clock3 = solid(PhClock, "fill", "lucide-clock3 lucide-clock-3", "Clock3");
export const Cloud = solid(PhCloud, "fill", "lucide-cloud", "Cloud");
export const CloudUpload = solid(PhCloudArrowUp, "fill", "lucide-cloud-upload", "CloudUpload");
export const Code = solid(PhCode, "bold", "lucide-code", "Code");
export const Code2 = solid(PhCodeSimple, "bold", "lucide-code-xml", "Code2");
export const Columns2 = solid(PhColumns, "fill", "lucide-columns2 lucide-columns-2", "Columns2");
export const Columns3 = solid(PhColumns, "fill", "lucide-columns3 lucide-columns-3", "Columns3");
export const Command = solid(PhCommand, "bold", "lucide-command", "Command");
export const Compass = solid(PhCompass, "fill", "lucide-compass", "Compass");
export const Contact = solid(PhIdentificationBadge, "fill", "lucide-contact", "Contact");
export const Copy = solid(PhCopy, "fill", "lucide-copy", "Copy");
export const CopyPlus = solid(PhCopySimple, "fill", "lucide-copy-plus", "CopyPlus");
export const Cpu = solid(PhCpu, "fill", "lucide-cpu", "Cpu");
export const Crosshair = solid(PhCrosshair, "fill", "lucide-crosshair", "Crosshair");
export const Database = solid(PhDatabase, "fill", "lucide-database", "Database");
export const Diamond = solid(PhDiamond, "fill", "lucide-diamond", "Diamond");
export const Diff = solid(PhGitDiff, "fill", "lucide-diff", "Diff");
export const Download = solid(PhDownloadSimple, "fill", "lucide-download", "Download");
export const Equal = solid(PhEquals, "bold", "lucide-equal", "Equal");
export const Eraser = solid(PhEraser, "fill", "lucide-eraser", "Eraser");
export const Expand = solid(PhArrowsOut, "bold", "lucide-expand", "Expand");
export const ExternalLink = solid(PhArrowSquareOut, "fill", "lucide-external-link", "ExternalLink");
export const Eye = solid(PhEye, "fill", "lucide-eye", "Eye");
export const EyeOff = solid(PhEyeSlash, "fill", "lucide-eye-off", "EyeOff");
export const File = solid(PhFile, "fill", "lucide-file", "File");
export const FileCode = solid(PhFileCode, "fill", "lucide-file-code", "FileCode");
export const FileDiff = solid(PhGitDiff, "fill", "lucide-file-diff", "FileDiff");
export const FileDown = solid(PhFileArrowDown, "fill", "lucide-file-down", "FileDown");
export const FileEdit = solid(PhNotePencil, "fill", "lucide-file-pen", "FileEdit");
export const FileJson = solid(PhBracketsCurly, "fill", "lucide-file-braces", "FileJson");
export const FilePenLine = solid(PhNotePencil, "fill", "lucide-file-pen-line", "FilePenLine");
export const FilePlus = solid(PhFilePlus, "fill", "lucide-file-plus", "FilePlus");
export const FilePlus2 = solid(PhFilePlus, "fill", "lucide-file-plus-corner", "FilePlus2");
export const Files = solid(PhFiles, "fill", "lucide-files", "Files");
export const FileStack = solid(PhFiles, "fill", "lucide-file-stack", "FileStack");
export const FileSymlink = solid(PhFileArrowUp, "fill", "lucide-file-symlink", "FileSymlink");
export const FileText = solid(PhFileText, "fill", "lucide-file-text", "FileText");
export const Flag = solid(PhFlag, "fill", "lucide-flag", "Flag");
export const FlaskConical = solid(PhFlask, "fill", "lucide-flask-conical", "FlaskConical");
export const Folder = solid(PhFolder, "fill", "lucide-folder", "Folder");
export const FolderGit2 = solid(PhFolderSimple, "fill", "lucide-folder-git2 lucide-folder-git-2", "FolderGit2");
export const FolderInput = solid(PhFolderOpen, "fill", "lucide-folder-input", "FolderInput");
export const FolderKanban = solid(PhKanban, "fill", "lucide-folder-kanban", "FolderKanban");
export const FolderMinus = solid(PhFolderMinus, "fill", "lucide-folder-minus", "FolderMinus");
export const FolderOpen = solid(PhFolderOpen, "fill", "lucide-folder-open", "FolderOpen");
export const FolderPlus = solid(PhFolderPlus, "fill", "lucide-folder-plus", "FolderPlus");
export const FolderSearch = solid(PhFolderOpen, "fill", "lucide-folder-search", "FolderSearch");
export const FolderSync = solid(PhArrowsClockwise, "bold", "lucide-folder-sync", "FolderSync");
export const FolderTree = solid(PhTreeView, "fill", "lucide-folder-tree", "FolderTree");
export const FolderX = solid(PhFolderMinus, "fill", "lucide-folder-x", "FolderX");
export const Footprints = solid(PhFootprints, "fill", "lucide-footprints", "Footprints");
export const Gauge = solid(PhGauge, "fill", "lucide-gauge", "Gauge");
export const GitBranch = solid(PhGitBranch, "fill", "lucide-git-branch", "GitBranch");
export const GitCommitHorizontal = solid(PhGitCommit, "fill", "lucide-git-commit-horizontal", "GitCommitHorizontal");
export const GitFork = solid(PhGitFork, "fill", "lucide-git-fork", "GitFork");
export const GitMerge = solid(PhGitMerge, "fill", "lucide-git-merge", "GitMerge");
export const Globe = solid(PhGlobe, "fill", "lucide-globe", "Globe");
export const Globe2 = solid(PhGlobeHemisphereWest, "fill", "lucide-earth", "Globe2");
export const GraduationCap = solid(PhGraduationCap, "fill", "lucide-graduation-cap", "GraduationCap");
export const Grip = solid(PhDotsNine, "bold", "lucide-grip", "Grip");
export const GripHorizontal = solid(PhDotsSix, "bold", "lucide-grip-horizontal", "GripHorizontal");
export const GripVertical = solid(PhDotsSixVertical, "bold", "lucide-grip-vertical", "GripVertical");
export const Hand = solid(PhHand, "fill", "lucide-hand", "Hand");
export const HardDrive = solid(PhHardDrive, "fill", "lucide-hard-drive", "HardDrive");
export const Hash = solid(PhHash, "bold", "lucide-hash", "Hash");
export const Heading = solid(PhTextH, "bold", "lucide-heading", "Heading");
export const HelpCircle = solid(PhQuestion, "fill", "lucide-circle-question-mark", "HelpCircle");
export const History = solid(PhClockCounterClockwise, "fill", "lucide-history", "History");
export const Home = solid(PhHouse, "fill", "lucide-house", "Home");
export const House = solid(PhHouse, "fill", "lucide-house", "House");
export const Image = solid(PhImage, "fill", "lucide-image", "Image");
export const ImageIcon = solid(PhImage, "fill", "lucide-image", "ImageIcon");
export const Import = solid(PhArrowSquareIn, "fill", "lucide-import", "Import");
export const Inbox = solid(PhTray, "fill", "lucide-inbox", "Inbox");
export const Info = solid(PhInfo, "fill", "lucide-info", "Info");
export const Keyboard = solid(PhKeyboard, "fill", "lucide-keyboard", "Keyboard");
export const KeyRound = solid(PhKey, "fill", "lucide-key-round", "KeyRound");
export const Laptop = solid(PhLaptop, "fill", "lucide-laptop", "Laptop");
export const Layers = solid(PhStack, "fill", "lucide-layers", "Layers");
export const Layers3 = solid(PhStack, "fill", "lucide-layers", "Layers3");
export const LayoutGrid = solid(PhSquaresFour, "fill", "lucide-layout-grid", "LayoutGrid");
export const LayoutList = solid(PhRows, "fill", "lucide-layout-list", "LayoutList");
export const LayoutPanelTop = solid(PhLayout, "fill", "lucide-layout-panel-top", "LayoutPanelTop");
export const Library = solid(PhBooks, "fill", "lucide-library", "Library");
export const LibraryBig = solid(PhBooks, "fill", "lucide-library-big", "LibraryBig");
export const Link = solid(PhLink, "bold", "lucide-link", "Link");
export const Link2 = solid(PhLinkSimple, "bold", "lucide-link2 lucide-link-2", "Link2");
export const Link2Off = solid(PhLinkBreak, "bold", "lucide-link2-off lucide-link-2-off", "Link2Off");
export const List = solid(PhList, "bold", "lucide-list", "List");
export const ListChecks = solid(PhListChecks, "fill", "lucide-list-checks", "ListChecks");
export const ListFilter = solid(PhFunnel, "fill", "lucide-list-filter", "ListFilter");
export const ListOrdered = solid(PhListNumbers, "fill", "lucide-list-ordered", "ListOrdered");
export const ListPlus = solid(PhListPlus, "fill", "lucide-list-plus", "ListPlus");
export const ListTodo = solid(PhListChecks, "fill", "lucide-list-todo", "ListTodo");
export const ListTree = solid(PhTreeStructure, "fill", "lucide-list-tree", "ListTree");
export const Loader2 = solid(PhCircleNotch, "bold", "lucide-loader-circle", "Loader2");
export const LoaderCircle = solid(PhCircleNotch, "bold", "lucide-loader-circle", "LoaderCircle");
export const Lock = solid(PhLock, "fill", "lucide-lock", "Lock");
export const LockKeyhole = solid(PhLockKey, "fill", "lucide-lock-keyhole", "LockKeyhole");
export const LogOut = solid(PhSignOut, "fill", "lucide-log-out", "LogOut");
export const MapPin = solid(PhMapPin, "fill", "lucide-map-pin", "MapPin");
export const Maximize = solid(PhArrowsOut, "bold", "lucide-maximize", "Maximize");
export const Maximize2 = solid(PhArrowsOutSimple, "bold", "lucide-maximize2 lucide-maximize-2", "Maximize2");
export const MessageCircle = solid(PhChatCircle, "fill", "lucide-message-circle", "MessageCircle");
export const MessageSquare = solid(PhChat, "fill", "lucide-message-square", "MessageSquare");
export const MessageSquareCode = solid(PhChatCenteredDots, "fill", "lucide-message-square-code", "MessageSquareCode");
export const MessageSquareText = solid(PhChatText, "fill", "lucide-message-square-text", "MessageSquareText");
export const MessagesSquare = solid(PhChats, "fill", "lucide-messages-square", "MessagesSquare");
export const Mic = solid(PhMicrophone, "fill", "lucide-mic", "Mic");
export const MicOff = solid(PhMicrophoneSlash, "fill", "lucide-mic-off", "MicOff");
export const Minimize2 = solid(PhArrowsInSimple, "bold", "lucide-minimize2 lucide-minimize-2", "Minimize2");
export const Minus = solid(PhMinus, "bold", "lucide-minus", "Minus");
export const MinusCircle = solid(PhMinusCircle, "fill", "lucide-circle-minus", "MinusCircle");
export const Monitor = solid(PhMonitor, "fill", "lucide-monitor", "Monitor");
export const MonitorCog = solid(PhDesktop, "fill", "lucide-monitor-cog", "MonitorCog");
export const MonitorSmartphone = solid(PhDevices, "fill", "lucide-monitor-smartphone", "MonitorSmartphone");
export const MoreHorizontal = solid(PhDotsThree, "bold", "lucide-ellipsis", "MoreHorizontal");
export const MousePointer2 = solid(PhCursor, "fill", "lucide-mouse-pointer2 lucide-mouse-pointer-2", "MousePointer2");
export const Move = solid(PhArrowsOutCardinal, "bold", "lucide-move", "Move");
export const MoveRight = solid(PhArrowRight, "bold", "lucide-move-right", "MoveRight");
export const Music = solid(PhMusicNote, "fill", "lucide-music", "Music");
export const Music2 = solid(PhMusicNotes, "fill", "lucide-music2 lucide-music-2", "Music2");
export const Network = solid(PhTreeStructure, "fill", "lucide-network", "Network");
export const Package = solid(PhPackage, "fill", "lucide-package", "Package");
export const Palette = solid(PhPalette, "fill", "lucide-palette", "Palette");
export const PanelBottom = solid(PhSquareHalfBottom, "fill", "lucide-panel-bottom", "PanelBottom");
export const PanelLeft = solid(PhSidebar, "fill", "lucide-panel-left", "PanelLeft");
export const PanelLeftClose = solid(PhSidebarSimple, "fill", "lucide-panel-left-close", "PanelLeftClose");
export const PanelRight = solid(PhSquareHalf, "fill", "lucide-panel-right", "PanelRight");
export const PanelRightClose = solid(PhSquareHalf, "fill", "lucide-panel-right-close", "PanelRightClose");
export const PanelRightOpen = solid(PhSquareHalf, "fill", "lucide-panel-right-open", "PanelRightOpen");
export const PanelsTopLeft = solid(PhLayout, "fill", "lucide-panels-top-left", "PanelsTopLeft");
export const PanelTop = solid(PhBrowser, "fill", "lucide-panel-top", "PanelTop");
export const PanelTopOpen = solid(PhBrowser, "fill", "lucide-panel-top-open", "PanelTopOpen");
export const Pause = solid(PhPause, "fill", "lucide-pause", "Pause");
export const Pencil = solid(PhPencilSimple, "fill", "lucide-pencil", "Pencil");
export const PenLine = solid(PhPencilLine, "fill", "lucide-pen-line", "PenLine");
export const PictureInPicture2 = solid(PhPictureInPicture, "fill", "lucide-picture-in-picture2 lucide-picture-in-picture-2", "PictureInPicture2");
export const Pin = solid(PhPushPin, "fill", "lucide-pin", "Pin");
export const PinOff = solid(PhPushPinSlash, "fill", "lucide-pin-off", "PinOff");
export const Play = solid(PhPlay, "fill", "lucide-play", "Play");
export const Plus = solid(PhPlus, "bold", "lucide-plus", "Plus");
export const Power = solid(PhPower, "fill", "lucide-power", "Power");
export const Radio = solid(PhRadio, "fill", "lucide-radio", "Radio");
export const Redo2 = solid(PhArrowUUpRight, "bold", "lucide-redo2 lucide-redo-2", "Redo2");
export const RefreshCw = solid(PhArrowsClockwise, "bold", "lucide-refresh-cw", "RefreshCw");
export const Repeat = solid(PhRepeat, "bold", "lucide-repeat", "Repeat");
export const Rocket = solid(PhRocket, "fill", "lucide-rocket", "Rocket");
export const RotateCcw = solid(PhArrowCounterClockwise, "bold", "lucide-rotate-ccw", "RotateCcw");
export const RotateCw = solid(PhArrowClockwise, "bold", "lucide-rotate-cw", "RotateCw");
export const Rows2 = solid(PhRows, "fill", "lucide-rows2 lucide-rows-2", "Rows2");
export const Rows3 = solid(PhRows, "fill", "lucide-rows3 lucide-rows-3", "Rows3");
export const Ruler = solid(PhRuler, "fill", "lucide-ruler", "Ruler");
export const Save = solid(PhFloppyDisk, "fill", "lucide-save", "Save");
export const Scan = solid(PhScan, "fill", "lucide-scan", "Scan");
export const ScanSearch = solid(PhMagnifyingGlass, "fill", "lucide-scan-search", "ScanSearch");
export const Search = solid(PhMagnifyingGlass, "fill", "lucide-search", "Search");
export const SearchIcon = solid(PhMagnifyingGlass, "fill", "lucide-search", "SearchIcon");
export const Send = solid(PhPaperPlaneTilt, "fill", "lucide-send", "Send");
export const SendHorizontal = solid(PhPaperPlaneRight, "fill", "lucide-send-horizontal", "SendHorizontal");
export const Server = solid(PhHardDrives, "fill", "lucide-server", "Server");
export const Settings = solid(PhGear, "fill", "lucide-settings", "Settings");
export const Settings2 = solid(PhSlidersHorizontal, "fill", "lucide-settings2 lucide-settings-2", "Settings2");
export const ShieldAlert = solid(PhShieldWarning, "fill", "lucide-shield-alert", "ShieldAlert");
export const ShieldCheck = solid(PhShieldCheck, "fill", "lucide-shield-check", "ShieldCheck");
export const ShieldQuestion = solid(PhShield, "fill", "lucide-shield-question-mark", "ShieldQuestion");
export const Shuffle = solid(PhShuffle, "bold", "lucide-shuffle", "Shuffle");
export const SlidersHorizontal = solid(PhSlidersHorizontal, "fill", "lucide-sliders-horizontal", "SlidersHorizontal");
export const Sparkles = solid(PhSparkle, "fill", "lucide-sparkles", "Sparkles");
export const SplitSquareHorizontal = solid(PhColumns, "fill", "lucide-square-split-horizontal", "SplitSquareHorizontal");
export const Square = solid(PhSquare, "bold", "lucide-square", "Square");
export const SquarePen = solid(PhNotePencil, "fill", "lucide-square-pen", "SquarePen");
export const SquareTerminal = solid(PhTerminalWindow, "fill", "lucide-square-terminal", "SquareTerminal");
export const Star = solid(PhStar, "fill", "lucide-star", "Star");
export const Sun = solid(PhSun, "fill", "lucide-sun", "Sun");
export const Tag = solid(PhTag, "fill", "lucide-tag", "Tag");
export const Target = solid(PhTarget, "fill", "lucide-target", "Target");
export const Terminal = solid(PhTerminal, "fill", "lucide-terminal", "Terminal");
export const TextSelect = solid(PhSelection, "fill", "lucide-text-select", "TextSelect");
export const Trash2 = solid(PhTrash, "fill", "lucide-trash2 lucide-trash-2", "Trash2");
export const Triangle = solid(PhTriangle, "fill", "lucide-triangle", "Triangle");
export const TriangleAlert = solid(PhWarning, "fill", "lucide-triangle-alert", "TriangleAlert");
export const Undo2 = solid(PhArrowUUpLeft, "bold", "lucide-undo2 lucide-undo-2", "Undo2");
export const User = solid(PhUser, "fill", "lucide-user", "User");
export const Wand2 = solid(PhMagicWand, "fill", "lucide-wand-sparkles", "Wand2");
export const Wifi = solid(PhWifiHigh, "fill", "lucide-wifi", "Wifi");
export const WifiOff = solid(PhWifiSlash, "fill", "lucide-wifi-off", "WifiOff");
export const Workflow = solid(PhFlowArrow, "fill", "lucide-workflow", "Workflow");
export const WrapText = solid(PhTextAlignLeft, "bold", "lucide-text-wrap", "WrapText");
export const Wrench = solid(PhWrench, "fill", "lucide-wrench", "Wrench");
export const X = solid(PhX, "bold", "lucide-x", "X");
export const XCircle = solid(PhXCircle, "fill", "lucide-circle-x", "XCircle");
export const XIcon = solid(PhX, "bold", "lucide-x", "XIcon");
export const Zap = solid(PhLightning, "fill", "lucide-zap", "Zap");
export const ZoomIn = solid(PhMagnifyingGlassPlus, "fill", "lucide-zoom-in", "ZoomIn");
export const ZoomOut = solid(PhMagnifyingGlassMinus, "fill", "lucide-zoom-out", "ZoomOut");
