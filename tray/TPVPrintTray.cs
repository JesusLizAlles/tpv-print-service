// Icono de TPV Print Service en el área de notificación (junto al reloj).
//
// El servicio de Windows no puede mostrar nada en el escritorio, así que este programita arranca
// con la sesión de cada usuario y consulta al agente por su API local cada 5 segundos:
//   verde  = el agente responde (y, si está vinculado, conectado a la cola del servidor)
//   ámbar  = el agente responde pero no llega al servidor de la cola, o está en modo simulación
//   rojo   = el agente no responde, o la vinculación ha sido revocada
// Avisa con una notificación cuando falla un trabajo de la cola o el agente deja de responder.
//
// Se compila con el csc.exe del .NET Framework 4 que trae Windows (C# 5: sin interpolación de
// cadenas ni operador ?.), sin dependencias. scripts/make-installer.mjs lo compila.
//
// Argumentos:
//   (ninguno)      icono en la bandeja (una instancia por sesión)
//   --open-panel   abre el panel en el navegador y termina
//   --check        comprueba que el agente responde; código de salida 0 si todo va bien (CI)

using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Net;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace TPVPrintTray
{
    static class Program
    {
        [STAThread]
        static int Main(string[] args)
        {
            // TLS 1.2 (el .NET Framework 4 no lo activa por defecto en todas las versiones de Windows).
            ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072;

            string arg = args.Length > 0 ? args[0] : "";
            if (arg == "--check") return Agent.Check();
            if (arg == "--open-panel")
            {
                Agent.OpenPanel();
                return 0;
            }

            bool created;
            using (Mutex mutex = new Mutex(true, "Local\\TPVPrintServiceTray", out created))
            {
                if (!created) return 0; // ya hay un icono en esta sesión
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new TrayContext());
            }
            return 0;
        }
    }

    /// <summary>Estado del agente leído de /api/admin/state.</summary>
    class AgentStatus
    {
        public bool Reachable;
        public string Error;
        public string Version;
        public string QueueState;
        public string Tpv;
        public string LastError;
        public int Printed;
        public int Failed;
        public bool UpdateAvailable;
        public string Latest;
        public string SimulateUntil;
    }

    static class Agent
    {
        public static readonly string DataDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "TPVPrint");

        /// <summary>Puerto y esquema de la API local, de config.json (legible por todos los usuarios).</summary>
        public static string BaseUrl()
        {
            int port = 3000;
            bool https = true;
            try
            {
                string json = File.ReadAllText(Path.Combine(DataDir, "config.json"));
                Dictionary<string, object> cfg = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(json);
                object v;
                if (cfg.TryGetValue("port", out v) && v != null) port = Convert.ToInt32(v);
                if (cfg.TryGetValue("https", out v) && v is bool) https = (bool)v;
            }
            catch (Exception)
            {
                // sin config: valores por defecto
            }
            return (https ? "https" : "http") + "://127.0.0.1:" + port;
        }

        public static void OpenPanel()
        {
            try
            {
                Process.Start(BaseUrl() + "/admin");
            }
            catch (Exception e)
            {
                MessageBox.Show("No se pudo abrir el navegador: " + e.Message, "TPV Print Service",
                    MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }

        public static AgentStatus Fetch()
        {
            AgentStatus s = new AgentStatus();
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(BaseUrl() + "/api/admin/state");
                req.Method = "GET";
                req.Accept = "application/json";
                req.Timeout = 4000;
                req.ReadWriteTimeout = 4000;
                req.UserAgent = "TPVPrintTray";
                string body;
                using (HttpWebResponse res = (HttpWebResponse)req.GetResponse())
                using (StreamReader reader = new StreamReader(res.GetResponseStream()))
                {
                    body = reader.ReadToEnd();
                }
                Dictionary<string, object> st = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(body);
                s.Reachable = true;
                s.Version = Str(st, "version");
                Dictionary<string, object> agent = Obj(st, "agent");
                if (agent != null)
                {
                    s.QueueState = Str(agent, "state");
                    s.Tpv = Str(agent, "tpvName");
                    s.LastError = Str(agent, "lastError");
                    s.Printed = Int(agent, "printed");
                    s.Failed = Int(agent, "failed");
                }
                Dictionary<string, object> cfg = Obj(st, "config");
                if (cfg != null) s.SimulateUntil = Str(cfg, "simulateUntil");
                Dictionary<string, object> upd = Obj(st, "updater");
                if (upd != null)
                {
                    object a;
                    s.UpdateAvailable = upd.TryGetValue("available", out a) && a is bool && (bool)a;
                    s.Latest = Str(upd, "latest");
                }
            }
            catch (Exception e)
            {
                s.Reachable = false;
                s.Error = e.Message;
            }
            return s;
        }

        /// <summary>Para el CI: 0 si el agente responde por HTTPS con un estado válido.</summary>
        public static int Check()
        {
            AgentStatus s = Fetch();
            return s.Reachable && !string.IsNullOrEmpty(s.Version) && !string.IsNullOrEmpty(s.QueueState) ? 0 : 2;
        }

        static string Str(Dictionary<string, object> d, string key)
        {
            object v;
            return d.TryGetValue(key, out v) && v != null ? Convert.ToString(v) : null;
        }

        static int Int(Dictionary<string, object> d, string key)
        {
            object v;
            return d.TryGetValue(key, out v) && v != null ? Convert.ToInt32(v) : 0;
        }

        static Dictionary<string, object> Obj(Dictionary<string, object> d, string key)
        {
            object v;
            return d.TryGetValue(key, out v) ? v as Dictionary<string, object> : null;
        }
    }

    class TrayContext : ApplicationContext
    {
        static readonly Color Navy = Color.FromArgb(0x00, 0x34, 0x57);
        static readonly Color Green = Color.FromArgb(0x16, 0xA3, 0x4A);
        static readonly Color Amber = Color.FromArgb(0xD9, 0x77, 0x06);
        static readonly Color Red = Color.FromArgb(0xDC, 0x26, 0x26);

        readonly NotifyIcon icon;
        readonly ToolStripMenuItem statusItem;
        readonly ToolStripMenuItem errorItem;
        readonly ToolStripMenuItem updateItem;
        readonly System.Windows.Forms.Timer timer;
        readonly SynchronizationContext ui;
        readonly Icon iconOk;
        readonly Icon iconWarn;
        readonly Icon iconBad;

        int polling;
        bool first = true;
        bool wasReachable = true;
        int lastFailed;

        public TrayContext()
        {
            ui = SynchronizationContext.Current ?? new WindowsFormsSynchronizationContext();
            iconOk = MakeIcon(Green);
            iconWarn = MakeIcon(Amber);
            iconBad = MakeIcon(Red);

            ContextMenuStrip menu = new ContextMenuStrip();
            ToolStripMenuItem title = new ToolStripMenuItem("TPV Print Service");
            title.Enabled = false;
            title.Font = new Font(title.Font, FontStyle.Bold);
            statusItem = new ToolStripMenuItem("Comprobando…");
            statusItem.Enabled = false;
            errorItem = new ToolStripMenuItem("");
            errorItem.Enabled = false;
            errorItem.Visible = false;
            updateItem = new ToolStripMenuItem("");
            updateItem.Enabled = false;
            updateItem.Visible = false;

            ToolStripMenuItem open = new ToolStripMenuItem("Abrir el panel", null, delegate { Agent.OpenPanel(); });
            open.Font = new Font(open.Font, FontStyle.Bold);

            menu.Items.Add(title);
            menu.Items.Add(statusItem);
            menu.Items.Add(errorItem);
            menu.Items.Add(updateItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(open);
            menu.Items.Add(new ToolStripMenuItem("Ver los registros", null, delegate { OpenLogs(); }));
            menu.Items.Add(new ToolStripMenuItem("Reiniciar el servicio…", null, delegate { RestartService(); }));
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(new ToolStripMenuItem("Ocultar el icono hasta el próximo inicio de sesión", null, delegate { ExitThread(); }));

            icon = new NotifyIcon();
            icon.Icon = iconWarn;
            icon.Text = "TPV Print Service";
            icon.ContextMenuStrip = menu;
            icon.DoubleClick += delegate { Agent.OpenPanel(); };
            icon.Visible = true;

            timer = new System.Windows.Forms.Timer();
            timer.Interval = 5000;
            timer.Tick += delegate { Poll(); };
            timer.Start();
            Poll();
        }

        void Poll()
        {
            // Una consulta a la vez, fuera del hilo de la interfaz.
            if (Interlocked.Exchange(ref polling, 1) == 1) return;
            ThreadPool.QueueUserWorkItem(delegate
            {
                AgentStatus s = Agent.Fetch();
                ui.Post(delegate
                {
                    Interlocked.Exchange(ref polling, 0);
                    Apply(s);
                }, null);
            });
        }

        void Apply(AgentStatus s)
        {
            string text;
            Icon img;
            if (!s.Reachable)
            {
                img = iconBad;
                text = "El servicio no responde";
            }
            else
            {
                switch (s.QueueState)
                {
                    case "conectado":
                        img = iconOk;
                        text = "Conectado" + (string.IsNullOrEmpty(s.Tpv) ? "" : " · " + s.Tpv);
                        break;
                    case "sin-vincular":
                        img = iconOk;
                        text = "Funcionando · sin vincular a la cola";
                        break;
                    case "revocado":
                        img = iconBad;
                        text = "Vinculación revocada: vuelve a vincularlo";
                        break;
                    case "sin-conexion":
                        img = iconWarn;
                        text = "Sin conexión con el servidor";
                        break;
                    default:
                        img = iconWarn;
                        text = "Conectando con el servidor…";
                        break;
                }
            }

            if (s.Reachable && !string.IsNullOrEmpty(s.SimulateUntil))
            {
                // En simulación no se imprime nada: que se vea siempre, aunque todo lo demás vaya bien.
                img = iconWarn;
                DateTime until;
                text = DateTime.TryParse(s.SimulateUntil, null, System.Globalization.DateTimeStyles.RoundtripKind, out until)
                    ? "Simulación: no se imprime hasta las " + until.ToLocalTime().ToString("HH:mm")
                    : "Simulación: no se imprime nada";
            }

            icon.Icon = img;
            icon.Text = Truncate("TPV Print Service · " + text, 63);
            statusItem.Text = text + (s.Reachable && s.Printed > 0 ? " · " + s.Printed + " impresos" : "");

            string err = s.Reachable ? s.LastError : s.Error;
            errorItem.Visible = !string.IsNullOrEmpty(err);
            errorItem.Text = "Último error: " + Truncate(err ?? "", 90);

            updateItem.Visible = s.UpdateAvailable;
            updateItem.Text = "Versión " + s.Latest + " disponible (se instala sola)";

            if (!first)
            {
                if (wasReachable && !s.Reachable)
                {
                    icon.ShowBalloonTip(8000, "Servicio de impresión", "El servicio de impresión no responde. Prueba a reiniciarlo desde este icono.", ToolTipIcon.Error);
                }
                else if (s.Reachable && s.Failed > lastFailed)
                {
                    icon.ShowBalloonTip(8000, "No se pudo imprimir", Truncate(s.LastError ?? "Error de impresora", 200), ToolTipIcon.Error);
                }
            }
            if (s.Reachable) lastFailed = s.Failed;
            wasReachable = s.Reachable;
            first = false;
        }

        void OpenLogs()
        {
            try
            {
                Process.Start("explorer.exe", "\"" + Path.Combine(Agent.DataDir, "logs") + "\"");
            }
            catch (Exception e)
            {
                MessageBox.Show(e.Message, "TPV Print Service", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }

        void RestartService()
        {
            // TPVPrintService.exe (WinSW) está en la carpeta de instalación, encima de tray\.
            string root = Path.GetDirectoryName(Path.GetDirectoryName(Application.ExecutablePath));
            ProcessStartInfo psi = new ProcessStartInfo(Path.Combine(root, "TPVPrintService.exe"), "restart");
            psi.Verb = "runas"; // pide permisos de administrador
            psi.WindowStyle = ProcessWindowStyle.Hidden;
            psi.UseShellExecute = true;
            try
            {
                Process.Start(psi);
                icon.ShowBalloonTip(4000, "Servicio de impresión", "Reiniciando el servicio…", ToolTipIcon.Info);
            }
            catch (Win32Exception)
            {
                // el usuario canceló el aviso de permisos
            }
        }

        protected override void ExitThreadCore()
        {
            timer.Stop();
            icon.Visible = false;
            icon.Dispose();
            base.ExitThreadCore();
        }

        static string Truncate(string s, int max)
        {
            return s.Length <= max ? s : s.Substring(0, max - 1) + "…";
        }

        /// <summary>Impresora blanca sobre cuadrado azul corporativo, con un punto de estado.</summary>
        static Icon MakeIcon(Color status)
        {
            int size = Math.Max(16, SystemInformation.SmallIconSize.Width);
            using (Bitmap bmp = new Bitmap(size, size))
            {
                using (Graphics g = Graphics.FromImage(bmp))
                {
                    g.SmoothingMode = SmoothingMode.AntiAlias;
                    g.Clear(Color.Transparent);
                    float u = size / 16f;

                    using (GraphicsPath bg = RoundedRect(new RectangleF(0, 0, size - 1, size - 1), 3 * u))
                    using (SolidBrush navy = new SolidBrush(Navy))
                    {
                        g.FillPath(navy, bg);
                    }

                    using (SolidBrush white = new SolidBrush(Color.White))
                    using (Pen pen = new Pen(Color.White, Math.Max(1f, 1.2f * u)))
                    {
                        g.DrawRectangle(pen, 4.5f * u, 2.5f * u, 7 * u, 3 * u);          // papel arriba
                        g.FillRectangle(white, 2.5f * u, 5.5f * u, 11 * u, 5 * u);         // cuerpo
                        g.DrawRectangle(pen, 4.5f * u, 9.5f * u, 7 * u, 4 * u);           // ticket
                    }

                    float d = 7 * u;
                    RectangleF dot = new RectangleF(size - d - 0.5f, size - d - 0.5f, d, d);
                    using (SolidBrush b = new SolidBrush(status))
                    using (Pen ring = new Pen(Color.White, Math.Max(1f, u)))
                    {
                        g.FillEllipse(b, dot);
                        g.DrawEllipse(ring, dot);
                    }
                }
                IntPtr h = bmp.GetHicon();
                // Se clona para que el icono no dependa del handle (se crean solo 3 al arrancar).
                return (Icon)Icon.FromHandle(h).Clone();
            }
        }

        static GraphicsPath RoundedRect(RectangleF r, float radius)
        {
            float d = radius * 2;
            GraphicsPath p = new GraphicsPath();
            p.AddArc(r.X, r.Y, d, d, 180, 90);
            p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            p.CloseFigure();
            return p;
        }
    }
}
