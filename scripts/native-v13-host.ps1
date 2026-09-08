param(
  [ValidateSet('inventory','move','span','capture','click','drag')][string]$Mode='inventory',
  [int]$AppPid=0,[string]$ExpectedPath='',[int]$Monitor=0,
  [int]$Width=1600,[int]$Height=1000,[int]$X=0,[int]$Y=0,[int]$DeltaX=0,
  [string]$OutputPath=''
)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class V13Native {
 [StructLayout(LayoutKind.Sequential)] public struct Rect {public int Left,Top,Right,Bottom;}
 [StructLayout(LayoutKind.Sequential)] public struct Point {public int X,Y;}
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] public struct MonitorInfo {public int Size;public Rect Bounds,Work;public uint Flags;[MarshalAs(UnmanagedType.ByValTStr,SizeConst=32)]public string Name;}
 public class MonitorRow {public string Name;public int Left,Top,Right,Bottom,WorkBottom,Scale;public bool Primary;}
 public delegate bool MonitorProc(IntPtr monitor,IntPtr hdc,ref Rect rect,IntPtr data);
 [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
 [DllImport("user32.dll")] public static extern bool EnumDisplayMonitors(IntPtr hdc,IntPtr clip,MonitorProc callback,IntPtr data);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern bool GetMonitorInfo(IntPtr monitor,ref MonitorInfo info);
 [DllImport("shcore.dll")] public static extern int GetScaleFactorForMonitor(IntPtr monitor,out int scale);
 [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hwnd);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd,out Rect rect);
 [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hwnd,out Rect rect);
 [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hwnd,ref Point point);
 [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hwnd,IntPtr after,int x,int y,int width,int height,uint flags);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd,int command);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd,IntPtr pid);
 [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint from,uint to,bool attach);
 public static void Focus(IntPtr hwnd){
  uint current=GetCurrentThreadId(),foreground=GetWindowThreadProcessId(GetForegroundWindow(),IntPtr.Zero),target=GetWindowThreadProcessId(hwnd,IntPtr.Zero);
  bool a=foreground!=current&&AttachThreadInput(current,foreground,true),b=target!=current&&target!=foreground&&AttachThreadInput(current,target,true);
  try{SetForegroundWindow(hwnd);}finally{if(b)AttachThreadInput(current,target,false);if(a)AttachThreadInput(current,foreground,false);}
 }
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point point);
 [DllImport("user32.dll")] public static extern void mouse_event(uint flags,uint dx,uint dy,uint data,UIntPtr extra);
 public static MonitorRow[] Monitors(){
  var list=new List<MonitorRow>();
  EnumDisplayMonitors(IntPtr.Zero,IntPtr.Zero,delegate(IntPtr h,IntPtr dc,ref Rect r,IntPtr d){
   var info=new MonitorInfo();info.Size=Marshal.SizeOf(info);GetMonitorInfo(h,ref info);int scale;GetScaleFactorForMonitor(h,out scale);
   list.Add(new MonitorRow{Name=info.Name,Left=info.Bounds.Left,Top=info.Bounds.Top,Right=info.Bounds.Right,Bottom=info.Bounds.Bottom,WorkBottom=info.Work.Bottom,Primary=(info.Flags&1)!=0,Scale=scale});return true;
  },IntPtr.Zero);return list.ToArray();
 }
}
'@
$previous=[V13Native]::SetThreadDpiAwarenessContext([IntPtr](-4))
try {
 if($Mode -eq 'inventory') {[V13Native]::Monitors() | ConvertTo-Json -Depth 4;exit}
 $proc=Get-Process -Id $AppPid
 if(!$ExpectedPath -or $proc.Path -ne $ExpectedPath){throw 'Application path identity mismatch'}
 $hwnd=$proc.MainWindowHandle
 if(!$hwnd){throw 'No native application window'}
 if($Mode -eq 'span') {
  [V13Native]::ShowWindow($hwnd,9) | Out-Null
  [V13Native]::SetWindowPos($hwnd,[IntPtr]::Zero,$X,$Y,$Width,$Height,0x0014) | Out-Null
  Start-Sleep -Milliseconds 700
 }
 if($Mode -eq 'move') {
  $m=[V13Native]::Monitors()[$Monitor]
  [V13Native]::ShowWindow($hwnd,9) | Out-Null
  $w=[Math]::Min($Width,$m.Right-$m.Left-60);$h=[Math]::Min($Height,$m.WorkBottom-$m.Top-60)
  [V13Native]::SetWindowPos($hwnd,[IntPtr]::Zero,$m.Left+30,$m.Top+30,$w,$h,0x0014) | Out-Null
  Start-Sleep -Milliseconds 1200
 }
 $rect=New-Object V13Native+Rect;$client=New-Object V13Native+Rect;$origin=New-Object V13Native+Point
 [V13Native]::GetWindowRect($hwnd,[ref]$rect) | Out-Null
 [V13Native]::GetClientRect($hwnd,[ref]$client) | Out-Null
 [V13Native]::ClientToScreen($hwnd,[ref]$origin) | Out-Null
 if($Mode -in @('capture','click','drag')) {
  $foreground=[V13Native]::GetForegroundWindow()
  [V13Native]::Focus($hwnd)
  Start-Sleep -Milliseconds 400
  if([V13Native]::GetForegroundWindow() -ne $hwnd){throw 'Test window did not become foreground'}
  if($Mode -eq 'capture') {
   if(!$OutputPath){throw 'Screenshot output required'}
   $bitmap=New-Object Drawing.Bitmap ($client.Right-$client.Left),($client.Bottom-$client.Top)
   $graphics=[Drawing.Graphics]::FromImage($bitmap)
   try{$graphics.CopyFromScreen($origin.X,$origin.Y,0,0,$bitmap.Size);$bitmap.Save($OutputPath,[Drawing.Imaging.ImageFormat]::Png)}finally{$graphics.Dispose();$bitmap.Dispose()}
  } else {
   $cursor=New-Object V13Native+Point;[V13Native]::GetCursorPos([ref]$cursor) | Out-Null
   try{
    [V13Native]::SetCursorPos($origin.X+$X,$origin.Y+$Y) | Out-Null
    [V13Native]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
    if($Mode -eq 'drag'){for($i=1;$i -le 10;$i++){[V13Native]::SetCursorPos($origin.X+$X+[int]($DeltaX*$i/10),$origin.Y+$Y) | Out-Null;Start-Sleep -Milliseconds 30}}
    [V13Native]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
   }finally{[V13Native]::SetCursorPos($cursor.X,$cursor.Y) | Out-Null}
  }
  if($foreground -and $foreground -ne $hwnd){[V13Native]::SetForegroundWindow($foreground) | Out-Null}
 }
 [pscustomobject]@{AppPid=$AppPid;Hwnd=$hwnd.ToInt64();Dpi=[V13Native]::GetDpiForWindow($hwnd);Rect=$rect;Client=$client;Origin=$origin;Monitors=[V13Native]::Monitors()} | ConvertTo-Json -Depth 5
}finally{[V13Native]::SetThreadDpiAwarenessContext($previous) | Out-Null}
