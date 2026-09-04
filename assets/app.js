(function () {
  "use strict";

  const STORAGE_KEY = "teacher_portal_state_v2";
  const SESSION_KEY = "teacher_portal_session_v2";
  const CLOUD_SETTINGS_KEY = "teacher_portal_cloud_v1";
  const CLOUD_TABLE = "portal_snapshots";

  const appRoot = document.getElementById("appRoot");

  const ui = {
    authMode: "login",
    activeTabs: {
      admin: "users",
      teacher: "schedule",
      student: "schedule"
    },
    editingUserId: null,
    editingScheduleId: null,
    teacherSelectedDate: currentDateISO(0),
    teacherCalendarOffset: 0,
    teacherSelectedLessonId: null,
    teacherSubjectFilter: "all",
    studentSelectedDate: currentDateISO(0),
    studentCalendarOffset: 0,
    modalAssignmentId: null,
    message: null
  };

  const db = loadDb();
  const session = loadSession();
  const cloud = loadCloudSettings();
  let sbClient = null;
  let cloudSyncTimer = null;

  bindGlobalEvents();
  renderApp();

  function createSeedData() {
    return {
      users: {
        admin_001: {
          id: "admin_001",
          name: "Адміністратор",
          email: "admin@example.com",
          password: "demo123",
          role: "admin"
        },
        teacher_001: {
          id: "teacher_001",
          name: "Іван Петренко",
          email: "teacher@example.com",
          password: "demo123",
          role: "teacher",
          canAddStudents: true,
          students: ["student_001", "student_002"]
        },
        student_001: {
          id: "student_001",
          name: "Марія Іванова",
          email: "maria@example.com",
          password: "demo123",
          role: "student"
        },
        student_002: {
          id: "student_002",
          name: "Петро Сидоренко",
          email: "petro@example.com",
          password: "demo123",
          role: "student"
        }
      },
      schedule: [
        {
          id: "sched_001",
          name: "Квадратні рівняння",
          subject: "Математика",
          date: currentDateISO(2),
          time: "15:00",
          platform: "Zoom",
          link: "https://zoom.us",
          teacherId: "teacher_001",
          studentIds: ["student_001", "student_002"],
          status: "planned"
        }
      ],
      assignments: [
        {
          id: "assign_001",
          title: "Рівняння другого степеня",
          description: "Розв'язати завдання 1-10 у зошиті.",
          deadline: currentDateISO(5),
          teacherId: "teacher_001",
          studentIds: ["student_001"],
          linkedLessonId: "sched_001",
          teacherFiles: ["worksheet.pdf"],
          studentStatus: {
            student_001: "not_started"
          },
          studentComments: {
            student_001: ""
          },
          studentSubmissions: {}
        }
      ],
      studentMaterials: {
        student_001: [
          {
            id: "mat_001",
            title: "Формули квадратного рівняння",
            description: "Короткий конспект і приклади.",
            date: currentDateISO(0),
            files: ["formula-sheet.pdf"],
            scheduleId: "sched_001"
          }
        ],
        student_002: []
      },
      personalNotes: {
        student_001: "Марія добре просувається.",
        student_002: "Петру варто більше часу виділяти практиці."
      },
      lessonNotes: {
        sched_001: "Повторити дискримінант на початку заняття."
      }
    };
  }

  function loadDb() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return createSeedData();
      const parsed = JSON.parse(raw);
      return mergeWithDefaults(parsed);
    } catch (err) {
      console.warn("Не вдалося прочитати стан, відновлено демо-дані.", err);
      return createSeedData();
    }
  }

  function mergeWithDefaults(value) {
    const seed = createSeedData();
    const safe = value && typeof value === "object" ? value : {};
    const schedule = (Array.isArray(safe.schedule) ? safe.schedule : seed.schedule).map((item) => ({
      ...item,
      subject: item.subject || item.name || "Предмет",
      status: item.status || "planned"
    }));
    return {
      users: safe.users || seed.users,
      schedule,
      assignments: Array.isArray(safe.assignments) ? safe.assignments : seed.assignments,
      studentMaterials: safe.studentMaterials || seed.studentMaterials,
      personalNotes: safe.personalNotes || seed.personalNotes,
      lessonNotes: safe.lessonNotes || seed.lessonNotes
    };
  }

  function loadSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return { currentUserId: null };
      const parsed = JSON.parse(raw);
      return { currentUserId: parsed.currentUserId || null };
    } catch (_) {
      return { currentUserId: null };
    }
  }

  function saveDb() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
    if (cloud.autoSync && isCloudConfigured()) {
      queueCloudPush();
    }
  }

  function saveSession() {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  }

  function loadCloudSettings() {
    try {
      const raw = localStorage.getItem(CLOUD_SETTINGS_KEY);
      if (!raw) return { url: "", anonKey: "", portalId: "", autoSync: false };
      const parsed = JSON.parse(raw);
      return {
        url: String(parsed.url || "").trim(),
        anonKey: String(parsed.anonKey || "").trim(),
        portalId: String(parsed.portalId || "").trim(),
        autoSync: !!parsed.autoSync
      };
    } catch (_) {
      return { url: "", anonKey: "", portalId: "", autoSync: false };
    }
  }

  function saveCloudSettings() {
    localStorage.setItem(CLOUD_SETTINGS_KEY, JSON.stringify(cloud));
    sbClient = null;
  }

  function isCloudConfigured() {
    return cloud.url.startsWith("http") && cloud.anonKey.startsWith("ey") && cloud.portalId.length >= 3;
  }

  function getSupabaseClient() {
    if (sbClient) return sbClient;
    if (!isCloudConfigured()) return null;
    if (!window.supabase || typeof window.supabase.createClient !== "function") return null;
    try {
      sbClient = window.supabase.createClient(cloud.url, cloud.anonKey);
      return sbClient;
    } catch (_) {
      sbClient = null;
      return null;
    }
  }

  function getCurrentUser() {
    if (!session.currentUserId) return null;
    return db.users[session.currentUserId] || null;
  }

  function bindGlobalEvents() {
    document.addEventListener("click", onClick);
    document.addEventListener("submit", onSubmit);
    document.addEventListener("change", onChange);
  }

  function onClick(event) {
    const actionEl = event.target.closest("[data-action]");
    if (!actionEl) return;
    const action = actionEl.getAttribute("data-action");
    if (!action) return;

    if (action === "switch-auth") {
      ui.authMode = actionEl.getAttribute("data-mode") || "login";
      ui.message = null;
      renderApp();
      return;
    }

    if (action === "logout") {
      session.currentUserId = null;
      saveSession();
      ui.message = { type: "success", text: "Вихід виконано." };
      renderApp();
      return;
    }

    if (action === "set-tab") {
      const tab = actionEl.getAttribute("data-tab");
      const role = actionEl.getAttribute("data-role");
      if (tab && role) {
        ui.activeTabs[role] = tab;
        renderApp();
      }
      return;
    }

    if (action === "teacher-shift-month") {
      const delta = Number(actionEl.getAttribute("data-delta") || "0");
      ui.teacherCalendarOffset += delta;
      renderApp();
      return;
    }

    if (action === "teacher-go-today") {
      ui.teacherSelectedDate = currentDateISO(0);
      ui.teacherCalendarOffset = 0;
      ui.teacherSelectedLessonId = null;
      renderApp();
      return;
    }

    if (action === "student-go-today") {
      ui.studentSelectedDate = currentDateISO(0);
      ui.studentCalendarOffset = 0;
      renderApp();
      return;
    }

    if (action === "teacher-select-date") {
      const date = actionEl.getAttribute("data-date");
      if (date) {
        ui.teacherSelectedDate = date;
        ui.teacherSelectedLessonId = null;
        renderApp();
      }
      return;
    }

    if (action === "teacher-select-lesson") {
      const id = actionEl.getAttribute("data-id");
      ui.teacherSelectedLessonId = id || null;
      renderApp();
      return;
    }

    if (action === "student-shift-month") {
      const delta = Number(actionEl.getAttribute("data-delta") || "0");
      ui.studentCalendarOffset += delta;
      renderApp();
      return;
    }

    if (action === "student-select-date") {
      const date = actionEl.getAttribute("data-date");
      if (date) {
        ui.studentSelectedDate = date;
        renderApp();
      }
      return;
    }

    if (action === "set-teacher-subject-filter") {
      ui.teacherSubjectFilter = actionEl.getAttribute("data-subject") || "all";
      ui.teacherSelectedLessonId = null;
      renderApp();
      return;
    }

    if (action === "delete-user") {
      const userId = actionEl.getAttribute("data-id");
      if (userId) removeUser(userId);
      return;
    }

    if (action === "edit-user") {
      ui.editingUserId = actionEl.getAttribute("data-id");
      renderApp();
      return;
    }

    if (action === "cancel-edit-user") {
      ui.editingUserId = null;
      renderApp();
      return;
    }

    if (action === "delete-schedule") {
      const id = actionEl.getAttribute("data-id");
      if (!id) return;
      db.schedule = db.schedule.filter((x) => x.id !== id);
      saveDb();
      renderApp();
      return;
    }

    if (action === "edit-schedule") {
      ui.editingScheduleId = actionEl.getAttribute("data-id");
      renderApp();
      return;
    }

    if (action === "cancel-edit-schedule") {
      ui.editingScheduleId = null;
      renderApp();
      return;
    }

    if (action === "delete-assignment") {
      const id = actionEl.getAttribute("data-id");
      if (!id) return;
      db.assignments = db.assignments.filter((x) => x.id !== id);
      saveDb();
      renderApp();
      return;
    }

    if (action === "delete-material") {
      const id = actionEl.getAttribute("data-id");
      const studentId = actionEl.getAttribute("data-student-id");
      if (!id || !studentId) return;
      db.studentMaterials[studentId] = (db.studentMaterials[studentId] || []).filter((m) => m.id !== id);
      saveDb();
      renderApp();
      return;
    }

    if (action === "open-submit-modal") {
      ui.modalAssignmentId = actionEl.getAttribute("data-id");
      renderApp();
      return;
    }

    if (action === "close-submit-modal") {
      ui.modalAssignmentId = null;
      renderApp();
      return;
    }

    if (action === "export-data") {
      exportData();
      return;
    }

    if (action === "import-data") {
      const input = document.getElementById("importFile");
      if (input) input.click();
      return;
    }

    if (action === "reset-demo") {
      if (!confirm("Скинути дані до демо-стану?")) return;
      const fresh = createSeedData();
      overwriteObject(db, fresh);
      session.currentUserId = null;
      saveDb();
      saveSession();
      ui.message = { type: "success", text: "Дані скинуто до демо-стану." };
      renderApp();
      return;
    }

    if (action === "save-cloud-settings") {
      const urlEl = document.getElementById("cloudUrl");
      const keyEl = document.getElementById("cloudAnonKey");
      const portalEl = document.getElementById("cloudPortalId");
      const autoEl = document.getElementById("cloudAutoSync");
      cloud.url = String(urlEl?.value || "").trim();
      cloud.anonKey = String(keyEl?.value || "").trim();
      cloud.portalId = String(portalEl?.value || "").trim();
      cloud.autoSync = !!autoEl?.checked;
      saveCloudSettings();
      ui.message = isCloudConfigured()
        ? { type: "success", text: "Налаштування Supabase збережено." }
        : { type: "error", text: "Перевір URL, anon key та portal id." };
      renderApp();
      return;
    }

    if (action === "clear-cloud-settings") {
      cloud.url = "";
      cloud.anonKey = "";
      cloud.portalId = "";
      cloud.autoSync = false;
      saveCloudSettings();
      ui.message = { type: "success", text: "Налаштування Supabase очищено." };
      renderApp();
      return;
    }

    if (action === "cloud-push") {
      void cloudPush(false);
      return;
    }

    if (action === "cloud-pull") {
      void cloudPull();
      return;
    }
  }

  function onSubmit(event) {
    const form = event.target;
    const id = form.getAttribute("id");
    if (!id) return;
    event.preventDefault();

    if (id === "loginForm") return submitLogin(form);
    if (id === "registerForm") return submitRegister(form);
    if (id === "resetForm") return submitReset(form);
    if (id === "adminCreateUserForm") return submitAdminCreateUser(form);
    if (id === "adminEditUserForm") return submitAdminEditUser(form);
    if (id === "teacherScheduleForm") return submitTeacherSchedule(form);
    if (id === "teacherAssignmentForm") return submitTeacherAssignment(form);
    if (id === "teacherQuickAssignmentForm") return submitTeacherQuickAssignment(form);
    if (id === "teacherLessonMetaForm") return submitTeacherLessonMeta(form);
    if (id === "teacherMaterialForm") return submitTeacherMaterial(form);
    if (id === "teacherNotesForm") return submitTeacherNote(form);
    if (id === "teacherAssignmentManageForm") return submitTeacherAssignmentManage(form);
    if (id === "studentSubmitForm") return submitStudentSolution(form);
  }

  function onChange(event) {
    const target = event.target;
    if (!target) return;
    if (target.id === "importFile") return importDataFromInput(target);
    if (target.id === "adminEditRole") return renderApp();
  }

  function submitLogin(form) {
    const email = readValue(form, "email").toLowerCase();
    const password = readValue(form, "password");
    const user = Object.values(db.users).find((u) => u.email.toLowerCase() === email && u.password === password);
    if (!user) {
      ui.message = { type: "error", text: "Невірний email або пароль." };
      renderApp();
      return;
    }
    session.currentUserId = user.id;
    saveSession();
    ui.message = { type: "success", text: "Вхід успішний." };
    renderApp();
  }

  function submitRegister(form) {
    const name = readValue(form, "name");
    const email = readValue(form, "email").toLowerCase();
    const password = readValue(form, "password");
    const password2 = readValue(form, "password2");

    if (!name || !email || !password || !password2) {
      ui.message = { type: "error", text: "Заповни всі поля." };
      renderApp();
      return;
    }
    if (!isValidEmail(email)) {
      ui.message = { type: "error", text: "Невірний формат email." };
      renderApp();
      return;
    }
    if (password.length < 6) {
      ui.message = { type: "error", text: "Пароль має містити мінімум 6 символів." };
      renderApp();
      return;
    }
    if (password !== password2) {
      ui.message = { type: "error", text: "Паролі не співпадають." };
      renderApp();
      return;
    }
    const exists = Object.values(db.users).some((u) => u.email.toLowerCase() === email);
    if (exists) {
      ui.message = { type: "error", text: "Користувач з таким email вже існує." };
      renderApp();
      return;
    }

    const id = "student_" + uid();
    db.users[id] = { id, name, email, password, role: "student" };
    db.personalNotes[id] = "";
    saveDb();
    ui.authMode = "login";
    ui.message = { type: "success", text: "Реєстрація виконана. Тепер увійди у систему." };
    renderApp();
  }

  function submitReset(form) {
    const email = readValue(form, "email").toLowerCase();
    const password = readValue(form, "password");
    const user = Object.values(db.users).find((u) => u.email.toLowerCase() === email);
    if (!user) {
      ui.message = { type: "error", text: "Користувача з таким email не знайдено." };
      renderApp();
      return;
    }
    if (password.length < 6) {
      ui.message = { type: "error", text: "Новий пароль має містити мінімум 6 символів." };
      renderApp();
      return;
    }
    user.password = password;
    saveDb();
    ui.authMode = "login";
    ui.message = { type: "success", text: "Пароль успішно оновлено." };
    renderApp();
  }

  function submitAdminCreateUser(form) {
    const current = getCurrentUser();
    if (!current || current.role !== "admin") return;
    const name = readValue(form, "name");
    const email = readValue(form, "email").toLowerCase();
    const password = readValue(form, "password");
    const role = readValue(form, "role");
    const canAddStudents = !!form.querySelector("[name='canAddStudents']")?.checked;
    const studentIds = readMulti(form, "students");

    if (!name || !email || !password || !role) {
      ui.message = { type: "error", text: "Заповни всі поля створення користувача." };
      renderApp();
      return;
    }
    if (!isValidEmail(email)) {
      ui.message = { type: "error", text: "Невірний формат email." };
      renderApp();
      return;
    }
    if (password.length < 6) {
      ui.message = { type: "error", text: "Пароль має містити мінімум 6 символів." };
      renderApp();
      return;
    }
    const exists = Object.values(db.users).some((u) => u.email.toLowerCase() === email);
    if (exists) {
      ui.message = { type: "error", text: "Цей email уже зайнятий." };
      renderApp();
      return;
    }

    const prefix = role === "teacher" ? "teacher_" : role === "admin" ? "admin_" : "student_";
    const id = prefix + uid();
    db.users[id] = {
      id,
      name,
      email,
      password,
      role
    };
    if (role === "teacher") {
      db.users[id].canAddStudents = canAddStudents;
      db.users[id].students = studentIds;
    }
    if (role === "student") {
      db.personalNotes[id] = "";
    }

    saveDb();
    ui.message = { type: "success", text: "Користувача створено." };
    renderApp();
  }

  function submitAdminEditUser(form) {
    const userId = ui.editingUserId;
    if (!userId || !db.users[userId]) return;
    const user = db.users[userId];
    const name = readValue(form, "name");
    const email = readValue(form, "email").toLowerCase();
    const password = readValue(form, "password");
    const role = readValue(form, "role");
    const canAddStudents = !!form.querySelector("[name='canAddStudents']")?.checked;
    const students = readMulti(form, "students");

    if (!name || !email || !role) {
      ui.message = { type: "error", text: "Ім'я, email та роль є обов'язковими." };
      renderApp();
      return;
    }
    if (!isValidEmail(email)) {
      ui.message = { type: "error", text: "Невірний формат email." };
      renderApp();
      return;
    }
    const duplicate = Object.values(db.users).some((x) => x.id !== userId && x.email.toLowerCase() === email);
    if (duplicate) {
      ui.message = { type: "error", text: "Email вже використовується іншим користувачем." };
      renderApp();
      return;
    }

    user.name = name;
    user.email = email;
    user.role = role;
    if (password) {
      if (password.length < 6) {
        ui.message = { type: "error", text: "Новий пароль має мінімум 6 символів." };
        renderApp();
        return;
      }
      user.password = password;
    }
    if (role === "teacher") {
      user.canAddStudents = canAddStudents;
      user.students = students;
    } else {
      delete user.canAddStudents;
      delete user.students;
    }

    normalizeRelationsAfterRoleChanges();
    saveDb();
    ui.editingUserId = null;
    ui.message = { type: "success", text: "Зміни користувача збережено." };
    renderApp();
  }

  function submitTeacherSchedule(form) {
    const current = getCurrentUser();
    if (!current || current.role !== "teacher") return;
    const name = readValue(form, "name");
    const subject = readValue(form, "subject");
    const date = readValue(form, "date");
    const time = readValue(form, "time");
    const platform = readValue(form, "platform");
    const link = readValue(form, "link");
    const status = readValue(form, "status");
    const studentIds = readMulti(form, "students");

    if (!name || !subject || !date || !time || !platform) {
      ui.message = { type: "error", text: "Для розкладу заповни предмет, назву, дату, час і платформу." };
      renderApp();
      return;
    }
    if (!studentIds.length) {
      ui.message = { type: "error", text: "Оберіть хоча б одного учня." };
      renderApp();
      return;
    }

    const item = {
      id: ui.editingScheduleId || ("sched_" + uid()),
      name,
      subject,
      date,
      time,
      platform,
      link,
      teacherId: current.id,
      studentIds,
      status: status || "planned"
    };

    if (ui.editingScheduleId) {
      const index = db.schedule.findIndex((x) => x.id === ui.editingScheduleId);
      if (index >= 0) db.schedule[index] = item;
    } else {
      db.schedule.push(item);
    }

    current.students = unique([...(current.students || []), ...studentIds]);
    ui.editingScheduleId = null;
    saveDb();
    ui.message = { type: "success", text: "Розклад оновлено." };
    renderApp();
  }

  function submitTeacherAssignment(form) {
    const current = getCurrentUser();
    if (!current || current.role !== "teacher") return;

    const title = readValue(form, "title");
    const description = readValue(form, "description");
    const deadline = readValue(form, "deadline");
    const linkedLessonId = readValue(form, "linkedLessonId");
    const teacherFilesText = readValue(form, "teacherFiles");
    const studentIds = readMulti(form, "students");

    if (!title || !deadline || !studentIds.length) {
      ui.message = { type: "error", text: "Для ДЗ вкажи назву, дедлайн і учнів." };
      renderApp();
      return;
    }

    const assignment = {
      id: "assign_" + uid(),
      title,
      description,
      deadline,
      teacherId: current.id,
      studentIds,
      linkedLessonId: linkedLessonId || null,
      teacherFiles: teacherFilesText.split(",").map((x) => x.trim()).filter(Boolean),
      studentStatus: {},
      studentComments: {},
      studentSubmissions: {}
    };

    studentIds.forEach((id) => {
      assignment.studentStatus[id] = "not_started";
      assignment.studentComments[id] = "";
    });

    db.assignments.push(assignment);
    saveDb();
    ui.message = { type: "success", text: "Домашнє завдання додано." };
    renderApp();
  }

  function submitTeacherQuickAssignment(form) {
    const lessonId = readValue(form, "lessonId");
    const lesson = db.schedule.find((s) => s.id === lessonId);
    if (!lesson) {
      ui.message = { type: "error", text: "Оберіть заняття для швидкого створення домашки." };
      renderApp();
      return;
    }

    const title = readValue(form, "title");
    const description = readValue(form, "description");
    const deadline = readValue(form, "deadline");
    const teacherFilesText = readValue(form, "teacherFiles");
    const studentIds = readMulti(form, "students");

    if (!title || !deadline || !studentIds.length) {
      ui.message = { type: "error", text: "Вкажи назву, дедлайн та хоча б одного учня." };
      renderApp();
      return;
    }

    const assignment = {
      id: "assign_" + uid(),
      title,
      description,
      deadline,
      teacherId: lesson.teacherId,
      studentIds,
      linkedLessonId: lesson.id,
      teacherFiles: teacherFilesText.split(",").map((x) => x.trim()).filter(Boolean),
      studentStatus: {},
      studentComments: {},
      studentSubmissions: {}
    };

    studentIds.forEach((id) => {
      assignment.studentStatus[id] = "not_started";
      assignment.studentComments[id] = "";
    });

    db.assignments.push(assignment);
    saveDb();
    ui.message = { type: "success", text: "Домашнє завдання додано з картки заняття." };
    renderApp();
  }

  function submitTeacherLessonMeta(form) {
    const lessonId = readValue(form, "lessonId");
    const lesson = db.schedule.find((s) => s.id === lessonId);
    if (!lesson) {
      ui.message = { type: "error", text: "Заняття не знайдено." };
      renderApp();
      return;
    }
    const status = readValue(form, "status");
    const note = readValue(form, "note");
    lesson.status = status || "planned";
    db.lessonNotes[lessonId] = note;
    saveDb();
    ui.message = { type: "success", text: "Статус і нотатки заняття збережено." };
    renderApp();
  }

  function submitTeacherMaterial(form) {
    const current = getCurrentUser();
    if (!current || current.role !== "teacher") return;
    const studentId = readValue(form, "studentId");
    const title = readValue(form, "title");
    const description = readValue(form, "description");
    const date = readValue(form, "date");
    const scheduleId = readValue(form, "scheduleId");
    const filesRaw = readValue(form, "files");

    if (!studentId || !title || !date) {
      ui.message = { type: "error", text: "Для матеріалу обов'язкові учень, назва і дата." };
      renderApp();
      return;
    }

    if (!db.studentMaterials[studentId]) db.studentMaterials[studentId] = [];
    db.studentMaterials[studentId].push({
      id: "mat_" + uid(),
      title,
      description,
      date,
      scheduleId: scheduleId || null,
      files: filesRaw.split(",").map((x) => x.trim()).filter(Boolean)
    });

    saveDb();
    ui.message = { type: "success", text: "Матеріал додано." };
    renderApp();
  }

  function submitTeacherNote(form) {
    const current = getCurrentUser();
    if (!current || current.role !== "teacher") return;
    const studentId = readValue(form, "studentId");
    const note = readValue(form, "note");
    if (!studentId) {
      ui.message = { type: "error", text: "Оберіть учня для збереження нотатки." };
      renderApp();
      return;
    }
    db.personalNotes[studentId] = note;
    saveDb();
    ui.message = { type: "success", text: "Нотатку збережено." };
    renderApp();
  }

  function submitTeacherAssignmentManage(form) {
    const assignId = readValue(form, "assignmentId");
    const studentId = readValue(form, "studentId");
    const status = readValue(form, "status");
    const comment = readValue(form, "comment");
    const assignment = db.assignments.find((a) => a.id === assignId);
    if (!assignment || !studentId) return;
    if (!assignment.studentStatus) assignment.studentStatus = {};
    if (!assignment.studentComments) assignment.studentComments = {};
    assignment.studentStatus[studentId] = status;
    assignment.studentComments[studentId] = comment;
    saveDb();
    ui.message = { type: "success", text: "Статус і коментар збережено." };
    renderApp();
  }

  function submitStudentSolution(form) {
    const user = getCurrentUser();
    if (!user || user.role !== "student") return;
    const assignment = db.assignments.find((a) => a.id === ui.modalAssignmentId);
    if (!assignment) return;
    const text = readValue(form, "solutionText");
    const filesRaw = readValue(form, "solutionFiles");

    if (!assignment.studentSubmissions) assignment.studentSubmissions = {};
    if (!assignment.studentStatus) assignment.studentStatus = {};
    if (!assignment.studentComments) assignment.studentComments = {};

    assignment.studentSubmissions[user.id] = {
      text,
      files: filesRaw.split(",").map((x) => x.trim()).filter(Boolean),
      date: new Date().toLocaleString("uk-UA")
    };
    assignment.studentStatus[user.id] = "in_progress";

    saveDb();
    ui.modalAssignmentId = null;
    ui.message = { type: "success", text: "Рішення відправлено викладачу." };
    renderApp();
  }

  function removeUser(userId) {
    const current = getCurrentUser();
    if (!current || current.role !== "admin") return;
    if (!db.users[userId]) return;
    if (db.users[userId].role === "admin") {
      const admins = Object.values(db.users).filter((u) => u.role === "admin");
      if (admins.length <= 1) {
        ui.message = { type: "error", text: "Не можна видалити останнього адміністратора." };
        renderApp();
        return;
      }
    }
    if (!confirm("Видалити користувача?")) return;

    delete db.users[userId];
    delete db.personalNotes[userId];
    delete db.studentMaterials[userId];

    Object.values(db.users).forEach((u) => {
      if (u.role === "teacher" && Array.isArray(u.students)) {
        u.students = u.students.filter((id) => id !== userId);
      }
    });
    db.schedule = db.schedule.filter((s) => s.teacherId !== userId && !s.studentIds.includes(userId));
    db.assignments = db.assignments.filter((a) => a.teacherId !== userId && !a.studentIds.includes(userId));

    if (session.currentUserId === userId) {
      session.currentUserId = null;
      saveSession();
    }

    saveDb();
    ui.message = { type: "success", text: "Користувача видалено." };
    renderApp();
  }

  function normalizeRelationsAfterRoleChanges() {
    const validStudentIds = new Set(getUsersByRole("student").map((u) => u.id));
    const validTeacherIds = new Set(getUsersByRole("teacher").map((u) => u.id));

    Object.values(db.users).forEach((u) => {
      if (u.role === "teacher") {
        u.students = unique((u.students || []).filter((id) => validStudentIds.has(id)));
        if (typeof u.canAddStudents !== "boolean") u.canAddStudents = false;
      } else {
        delete u.students;
        delete u.canAddStudents;
      }
    });

    db.schedule = db.schedule.filter((s) => validTeacherIds.has(s.teacherId));
    db.schedule.forEach((s) => {
      s.studentIds = (s.studentIds || []).filter((id) => validStudentIds.has(id));
    });

    db.assignments = db.assignments.filter((a) => validTeacherIds.has(a.teacherId));
    db.assignments.forEach((a) => {
      a.studentIds = (a.studentIds || []).filter((id) => validStudentIds.has(id));
      const status = a.studentStatus || {};
      const comments = a.studentComments || {};
      const submissions = a.studentSubmissions || {};
      Object.keys(status).forEach((id) => {
        if (!validStudentIds.has(id)) delete status[id];
      });
      Object.keys(comments).forEach((id) => {
        if (!validStudentIds.has(id)) delete comments[id];
      });
      Object.keys(submissions).forEach((id) => {
        if (!validStudentIds.has(id)) delete submissions[id];
      });
      a.studentStatus = status;
      a.studentComments = comments;
      a.studentSubmissions = submissions;
    });
  }

  function renderApp() {
    const user = getCurrentUser();
    if (!user) {
      appRoot.innerHTML = renderAuthView();
      return;
    }
    appRoot.innerHTML = renderDashboard(user);
  }

  function renderAuthView() {
    const mode = ui.authMode;
    return `
      <section class="auth-shell">
        <div class="auth-card">
          <div class="brand">
            <div class="brand-mark">TP</div>
            <div>
              <div class="brand-title">Teacher Portal</div>
              <div class="brand-sub">Повноцінний кабінет викладача, учня та адміністратора</div>
            </div>
          </div>
          ${renderMessage()}
          ${mode === "login" ? renderLoginForm() : ""}
          ${mode === "register" ? renderRegisterForm() : ""}
          ${mode === "reset" ? renderResetForm() : ""}
          <div class="card" style="margin-top:12px;">
            <p class="muted"><strong>Демо-акаунти:</strong></p>
            <p class="muted mono">admin@example.com / demo123</p>
            <p class="muted mono">teacher@example.com / demo123</p>
            <p class="muted mono">maria@example.com / demo123</p>
          </div>
        </div>
      </section>
    `;
  }

  function renderLoginForm() {
    return `
      <h1>Вхід</h1>
      <p class="muted">Увійди у свій кабінет.</p>
      <form id="loginForm" class="stack" style="margin-top:12px;">
        <div class="field">
          <label>Email</label>
          <input name="email" type="email" placeholder="name@email.com" required />
        </div>
        <div class="field">
          <label>Пароль</label>
          <input name="password" type="password" placeholder="••••••••" required />
        </div>
        <button class="btn primary" type="submit">Увійти</button>
      </form>
      <div class="toggle-text">Немає акаунта? <button data-action="switch-auth" data-mode="register" type="button">Реєстрація</button></div>
      <div class="toggle-text">Забули пароль? <button data-action="switch-auth" data-mode="reset" type="button">Відновити</button></div>
    `;
  }

  function renderRegisterForm() {
    return `
      <h1>Реєстрація</h1>
      <p class="muted">Створюється роль учня.</p>
      <form id="registerForm" class="stack" style="margin-top:12px;">
        <div class="field">
          <label>Ім'я</label>
          <input name="name" type="text" required />
        </div>
        <div class="field">
          <label>Email</label>
          <input name="email" type="email" required />
        </div>
        <div class="field">
          <label>Пароль</label>
          <input name="password" type="password" required />
        </div>
        <div class="field">
          <label>Підтвердження пароля</label>
          <input name="password2" type="password" required />
        </div>
        <button class="btn primary" type="submit">Зареєструватися</button>
      </form>
      <div class="toggle-text">Вже є акаунт? <button data-action="switch-auth" data-mode="login" type="button">Вхід</button></div>
    `;
  }

  function renderResetForm() {
    return `
      <h1>Оновлення пароля</h1>
      <p class="muted">Локальне скидання пароля за email.</p>
      <form id="resetForm" class="stack" style="margin-top:12px;">
        <div class="field">
          <label>Email</label>
          <input name="email" type="email" required />
        </div>
        <div class="field">
          <label>Новий пароль</label>
          <input name="password" type="password" required />
        </div>
        <button class="btn primary" type="submit">Зберегти новий пароль</button>
      </form>
      <div class="toggle-text"><button data-action="switch-auth" data-mode="login" type="button">Повернутися до входу</button></div>
    `;
  }

  function renderDashboard(user) {
    const roleClass = user.role === "admin" ? "role-admin" : user.role === "teacher" ? "role-teacher" : "role-student";
    const roleLabel = user.role === "admin" ? "Адміністратор" : user.role === "teacher" ? "Викладач" : "Учень";
    return `
      <section class="shell">
        <header class="topbar">
          <div class="container topbar-inner">
            <div>
              <div class="brand-title">Teacher Portal</div>
              <div class="muted">Привіт, <strong>${escapeHtml(user.name)}</strong></div>
            </div>
            <div class="row wrap">
              <span class="role-badge ${roleClass}">${roleLabel}</span>
              <button class="btn secondary small" data-action="logout" type="button">Вихід</button>
            </div>
          </div>
        </header>
        <div class="container" style="padding:16px 0 26px;">
          ${renderMessage()}
          ${user.role === "admin" ? renderAdminDashboard() : ""}
          ${user.role === "teacher" ? renderTeacherDashboard(user) : ""}
          ${user.role === "student" ? renderStudentDashboard(user) : ""}
        </div>
      </section>
      ${renderStudentSubmitModal(user)}
    `;
  }

  function renderAdminDashboard() {
    const tab = ui.activeTabs.admin;
    const users = Object.values(db.users).sort((a, b) => a.name.localeCompare(b.name, "uk"));
    const studentOptions = getUsersByRole("student")
      .map((s) => `<option value="${s.id}">${escapeHtml(s.name)} (${escapeHtml(s.email)})</option>`)
      .join("");
    const editingUser = ui.editingUserId ? db.users[ui.editingUserId] : null;

    return `
      ${renderTabs("admin", [
        { id: "users", label: "Користувачі" },
        { id: "backup", label: "Дані та резерв" }
      ])}
      <section class="panel ${tab === "users" ? "active" : ""}">
        <div class="grid cols-2">
          <div class="card">
            <h3>Створити користувача</h3>
            <form id="adminCreateUserForm" class="stack">
              <div class="field"><label>Ім'я</label><input name="name" required /></div>
              <div class="field"><label>Email</label><input name="email" type="email" required /></div>
              <div class="field"><label>Пароль</label><input name="password" type="password" required /></div>
              <div class="field">
                <label>Роль</label>
                <select name="role" required>
                  <option value="student">Учень</option>
                  <option value="teacher">Викладач</option>
                  <option value="admin">Адміністратор</option>
                </select>
              </div>
              <label class="row"><input type="checkbox" name="canAddStudents" /> Викладач може сам додавати учнів</label>
              <div class="field">
                <label>Учні для викладача (якщо роль teacher)</label>
                <select name="students" multiple size="6">${studentOptions}</select>
              </div>
              <button class="btn primary" type="submit">Створити</button>
            </form>
          </div>
          <div class="card">
            <h3>Редагування користувача</h3>
            ${editingUser ? renderAdminEditUserForm(editingUser) : '<p class="muted">Обери користувача в списку праворуч.</p>'}
          </div>
        </div>
        <div class="card" style="margin-top:14px;">
          <h3>Список користувачів</h3>
          <div class="list">
            ${users.map((u) => renderUserItem(u)).join("")}
          </div>
        </div>
      </section>
      <section class="panel ${tab === "backup" ? "active" : ""}">
        <div class="grid cols-2">
          <div class="card">
            <h3>Експорт / імпорт</h3>
            <p class="muted">Можна зберігати резервні копії всього сайту.</p>
            <div class="row wrap" style="margin-top:10px;">
              <button type="button" class="btn secondary" data-action="export-data">Експорт JSON</button>
              <button type="button" class="btn secondary" data-action="import-data">Імпорт JSON</button>
              <input id="importFile" type="file" accept=".json,application/json" class="hidden" />
            </div>
            <div class="filebox" style="margin-top:12px;">
              <strong>Supabase Cloud Sync</strong>
              <div class="meta">Статус: ${renderCloudStatus()}</div>
              <div class="stack" style="margin-top:8px;">
                <div class="field"><label>Supabase URL</label><input id="cloudUrl" value="${escapeAttr(cloud.url)}" placeholder="https://xxxx.supabase.co" /></div>
                <div class="field"><label>Supabase anon key</label><input id="cloudAnonKey" value="${escapeAttr(cloud.anonKey)}" placeholder="ey..." /></div>
                <div class="field"><label>Portal ID (простір даних школи)</label><input id="cloudPortalId" value="${escapeAttr(cloud.portalId)}" placeholder="teacher-portal-main" /></div>
                <label class="row"><input id="cloudAutoSync" type="checkbox" ${cloud.autoSync ? "checked" : ""} /> Автосинхронізація після змін</label>
              </div>
              <div class="row wrap" style="margin-top:10px;">
                <button type="button" class="btn secondary small" data-action="save-cloud-settings">Зберегти Cloud</button>
                <button type="button" class="btn secondary small" data-action="cloud-push">Push в Cloud</button>
                <button type="button" class="btn secondary small" data-action="cloud-pull">Pull з Cloud</button>
                <button type="button" class="btn danger small" data-action="clear-cloud-settings">Очистити Cloud</button>
              </div>
            </div>
          </div>
          <div class="card danger-zone">
            <h3>Скидання</h3>
            <p class="muted">Повертає систему у демо-стан.</p>
            <button type="button" class="btn danger" data-action="reset-demo">Скинути демо</button>
          </div>
        </div>
      </section>
    `;
  }

  function renderAdminEditUserForm(user) {
    const students = getUsersByRole("student");
    const selected = new Set(user.students || []);
    const isTeacher = user.role === "teacher";
    return `
      <form id="adminEditUserForm" class="stack">
        <div class="field"><label>Ім'я</label><input name="name" value="${escapeAttr(user.name)}" required /></div>
        <div class="field"><label>Email</label><input type="email" name="email" value="${escapeAttr(user.email)}" required /></div>
        <div class="field"><label>Новий пароль (необов'язково)</label><input type="password" name="password" /></div>
        <div class="field">
          <label>Роль</label>
          <select name="role" id="adminEditRole">
            <option value="student" ${user.role === "student" ? "selected" : ""}>Учень</option>
            <option value="teacher" ${user.role === "teacher" ? "selected" : ""}>Викладач</option>
            <option value="admin" ${user.role === "admin" ? "selected" : ""}>Адміністратор</option>
          </select>
        </div>
        <label class="row ${isTeacher ? "" : "hidden"}"><input type="checkbox" name="canAddStudents" ${user.canAddStudents ? "checked" : ""} /> Викладач може сам додавати учнів</label>
        <div class="field ${isTeacher ? "" : "hidden"}">
          <label>Призначені учні</label>
          <select name="students" multiple size="6">
            ${students.map((s) => `<option value="${s.id}" ${selected.has(s.id) ? "selected" : ""}>${escapeHtml(s.name)} (${escapeHtml(s.email)})</option>`).join("")}
          </select>
        </div>
        <div class="row wrap">
          <button class="btn primary" type="submit">Зберегти</button>
          <button class="btn secondary" type="button" data-action="cancel-edit-user">Скасувати</button>
        </div>
      </form>
    `;
  }

  function renderUserItem(user) {
    const extra = user.role === "teacher" ? `<div class="meta">Учнів: ${(user.students || []).length} • Дозвіл додавати: ${user.canAddStudents ? "так" : "ні"}</div>` : "";
    return `
      <div class="item">
        <div class="item-head">
          <div>
            <p class="item-title">${escapeHtml(user.name)}</p>
            <div class="meta">${escapeHtml(user.email)} • роль: ${escapeHtml(user.role)}</div>
            ${extra}
          </div>
          <div class="row wrap">
            <button class="btn small secondary" data-action="edit-user" data-id="${user.id}" type="button">Редагувати</button>
            <button class="btn small danger" data-action="delete-user" data-id="${user.id}" type="button">Видалити</button>
          </div>
        </div>
      </div>
    `;
  }

  function renderTeacherDashboard(teacher) {
    const tab = ui.activeTabs.teacher;
    const students = getTeacherStudents(teacher.id);
    const studentOptions = students.map((s) => `<option value="${s.id}">${escapeHtml(s.name)} (${escapeHtml(s.email)})</option>`).join("");
    const allTeacherLessons = db.schedule
      .filter((s) => s.teacherId === teacher.id)
      .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
    const subjectList = unique(allTeacherLessons.map((s) => s.subject || "Предмет")).sort((a, b) => a.localeCompare(b, "uk"));
    const filteredLessons = ui.teacherSubjectFilter === "all"
      ? allTeacherLessons
      : allTeacherLessons.filter((s) => (s.subject || "Предмет") === ui.teacherSubjectFilter);
    const scheduleOptions = filteredLessons
      .map((s) => `<option value="${s.id}">${escapeHtml(formatDateTime(s.date, s.time) + " • " + s.name)}</option>`)
      .join("");
    const editingSchedule = ui.editingScheduleId ? db.schedule.find((s) => s.id === ui.editingScheduleId) : null;
    const calendarBase = monthWithOffset(ui.teacherCalendarOffset);
    const teacherLessons = filteredLessons;
    const dayLessons = teacherLessons.filter((s) => s.date === ui.teacherSelectedDate);
    const selectedLesson = dayLessons.find((s) => s.id === ui.teacherSelectedLessonId) || dayLessons[0] || null;
    const freeSlots = getFreeTimeSlots(dayLessons);
    const linkedAssignments = selectedLesson
      ? db.assignments.filter((a) => a.linkedLessonId === selectedLesson.id && a.teacherId === teacher.id)
      : [];
    const weekLessons = getLessonsForNextDays(allTeacherLessons, 7);
    const todayCount = allTeacherLessons.filter((s) => s.date === currentDateISO(0)).length;
    const plannedCount = allTeacherLessons.filter((s) => (s.status || "planned") === "planned").length;
    const cancelledCount = allTeacherLessons.filter((s) => s.status === "cancelled").length;

    return `
      ${renderTabs("teacher", [
        { id: "schedule", label: "Розклад" },
        { id: "students", label: "Мої учні" },
        { id: "assignments", label: "Домашні" },
        { id: "materials", label: "Матеріали" }
      ])}
      <section class="panel ${tab === "schedule" ? "active" : ""}">
        <div class="grid cols-2 stats-grid">
          <div class="card stat-card"><div class="muted">Сьогодні занять</div><div class="stat-value">${todayCount}</div></div>
          <div class="card stat-card"><div class="muted">Заплановано</div><div class="stat-value">${plannedCount}</div></div>
          <div class="card stat-card"><div class="muted">Скасовано</div><div class="stat-value">${cancelledCount}</div></div>
          <div class="card stat-card"><div class="muted">Мої учні</div><div class="stat-value">${students.length}</div></div>
        </div>
        <div class="card" style="margin-top:10px;">
          <div class="row wrap" style="justify-content: space-between;">
            <div class="row wrap">
              <strong>Фільтр предмета:</strong>
              <button class="btn small ${ui.teacherSubjectFilter === "all" ? "primary" : "secondary"}" type="button" data-action="set-teacher-subject-filter" data-subject="all">Усі</button>
              ${subjectList.map((subject) => `<button class="btn small ${ui.teacherSubjectFilter === subject ? "primary" : "secondary"}" type="button" data-action="set-teacher-subject-filter" data-subject="${escapeAttr(subject)}">${escapeHtml(subject)}</button>`).join("")}
            </div>
            <button class="btn small secondary" type="button" data-action="teacher-go-today">Сьогодні</button>
          </div>
        </div>
        <div class="grid cols-2 calendar-layout">
          <div class="card calendar-main">
            <h3>Календар викладача</h3>
            ${renderCalendarWidget({
              baseDate: calendarBase,
              selectedDate: ui.teacherSelectedDate,
              lessons: teacherLessons,
              dayAction: "teacher-select-date",
              monthAction: "teacher-shift-month"
            })}
            <div class="filebox" style="margin-top:10px;">
              <strong>${escapeHtml(formatDate(ui.teacherSelectedDate))}</strong>
              <div class="meta">Вільні вікна: ${freeSlots.length ? freeSlots.join(", ") : "день щільно заповнений"}</div>
            </div>
          </div>
          <div class="card calendar-side">
            <h3>Заняття на день</h3>
            <div class="list">
              ${dayLessons.length ? dayLessons.map((lesson) => {
                const isActive = selectedLesson && selectedLesson.id === lesson.id;
                const studentsList = (lesson.studentIds || []).map((id) => db.users[id]?.name).filter(Boolean).join(", ");
                return `
                  <button type="button" class="lesson-card ${isActive ? "active" : ""}" data-action="teacher-select-lesson" data-id="${lesson.id}">
                    <div class="lesson-card-head">
                      <strong>${escapeHtml(lesson.time)} • ${escapeHtml(lesson.subject || "Предмет")}</strong>
                      <span class="pill ${statusPillClass(lesson.status)}">${escapeHtml(statusLabel(lesson.status))}</span>
                    </div>
                    <div class="meta">${escapeHtml(lesson.name)}</div>
                    <div class="meta">${escapeHtml(studentsList || "без учнів")}</div>
                  </button>
                `;
              }).join("") : '<p class="muted">На цей день занять немає.</p>'}
            </div>
          </div>
        </div>
        <div class="card" style="margin-top:14px;">
          <h3>Фокус на 7 днів</h3>
          <div class="list">
            ${weekLessons.length ? weekLessons.map((lesson) => `
              <div class="item">
                <div class="item-head">
                  <div>
                    <p class="item-title">${escapeHtml(formatDate(lesson.date))} • ${escapeHtml(lesson.time)} • ${escapeHtml(lesson.subject || "Предмет")}</p>
                    <div class="meta">${escapeHtml(lesson.name)}</div>
                  </div>
                  <span class="pill ${statusPillClass(lesson.status)}">${escapeHtml(statusLabel(lesson.status))}</span>
                </div>
              </div>
            `).join("") : '<p class="muted">На найближчі 7 днів занять немає.</p>'}
          </div>
        </div>
        <div class="grid cols-2" style="margin-top:14px;">
          <div class="card">
            <h3>${editingSchedule ? "Редагувати заняття" : "Нове заняття"}</h3>
            <form id="teacherScheduleForm" class="stack">
              <div class="field"><label>Предмет</label><input name="subject" value="${editingSchedule ? escapeAttr(editingSchedule.subject || "") : ""}" placeholder="Математика / Англійська / Фізика" required /></div>
              <div class="field"><label>Назва</label><input name="name" value="${editingSchedule ? escapeAttr(editingSchedule.name) : ""}" required /></div>
              <div class="grid cols-2">
                <div class="field"><label>Дата</label><input name="date" type="date" value="${editingSchedule ? escapeAttr(editingSchedule.date) : ""}" required /></div>
                <div class="field"><label>Час</label><input name="time" type="time" value="${editingSchedule ? escapeAttr(editingSchedule.time) : ""}" required /></div>
              </div>
              <div class="field"><label>Платформа</label><input name="platform" value="${editingSchedule ? escapeAttr(editingSchedule.platform) : ""}" placeholder="Zoom / Google Meet / Offline" required /></div>
              <div class="field">
                <label>Статус</label>
                <select name="status">
                  <option value="planned" ${editingSchedule?.status === "planned" ? "selected" : ""}>Заплановано</option>
                  <option value="done" ${editingSchedule?.status === "done" ? "selected" : ""}>Проведено</option>
                  <option value="cancelled" ${editingSchedule?.status === "cancelled" ? "selected" : ""}>Скасовано</option>
                </select>
              </div>
              <div class="field"><label>Посилання</label><input name="link" type="url" value="${editingSchedule ? escapeAttr(editingSchedule.link || "") : ""}" placeholder="https://..." /></div>
              <div class="field">
                <label>Учні</label>
                <select name="students" multiple size="6" required>
                  ${students.map((s) => {
                    const selected = editingSchedule && editingSchedule.studentIds.includes(s.id) ? "selected" : "";
                    return `<option value="${s.id}" ${selected}>${escapeHtml(s.name)}</option>`;
                  }).join("")}
                </select>
              </div>
              <div class="row wrap">
                <button class="btn primary" type="submit">${editingSchedule ? "Зберегти зміни" : "Створити заняття"}</button>
                ${editingSchedule ? '<button class="btn secondary" data-action="cancel-edit-schedule" type="button">Скасувати</button>' : ""}
              </div>
            </form>
          </div>
          <div class="card">
            <h3>Панель заняття</h3>
            ${selectedLesson ? `
              <div class="item">
                <p class="item-title">${escapeHtml(selectedLesson.subject || "Предмет")} • ${escapeHtml(selectedLesson.name)}</p>
                <div class="meta">${escapeHtml(formatDateTime(selectedLesson.date, selectedLesson.time))} • ${escapeHtml(selectedLesson.platform)}</div>
                ${selectedLesson.link ? `<div class="meta"><a href="${escapeAttr(selectedLesson.link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(selectedLesson.link)}</a></div>` : ""}
              </div>
              <form id="teacherLessonMetaForm" class="stack" style="margin-top:10px;">
                <input type="hidden" name="lessonId" value="${selectedLesson.id}" />
                <div class="field">
                  <label>Статус заняття</label>
                  <select name="status">
                    <option value="planned" ${selectedLesson.status === "planned" ? "selected" : ""}>Заплановано</option>
                    <option value="done" ${selectedLesson.status === "done" ? "selected" : ""}>Проведено</option>
                    <option value="cancelled" ${selectedLesson.status === "cancelled" ? "selected" : ""}>Скасовано</option>
                  </select>
                </div>
                <div class="field">
                  <label>Нотатки до заняття</label>
                  <textarea name="note" placeholder="Що пройшли, що дати повторити...">${escapeHtml(db.lessonNotes[selectedLesson.id] || "")}</textarea>
                </div>
                <button class="btn secondary" type="submit">Зберегти статус і нотатки</button>
              </form>
              <div class="filebox" style="margin-top:12px;">
                <strong>Швидко додати домашку до цього заняття</strong>
                <form id="teacherQuickAssignmentForm" class="stack" style="margin-top:8px;">
                  <input type="hidden" name="lessonId" value="${selectedLesson.id}" />
                  <div class="field"><label>Назва домашнього</label><input name="title" placeholder="Домашня робота #1" required /></div>
                  <div class="field"><label>Опис</label><textarea name="description"></textarea></div>
                  <div class="grid cols-2">
                    <div class="field"><label>Дедлайн</label><input type="date" name="deadline" required /></div>
                    <div class="field"><label>Файли (через кому)</label><input name="teacherFiles" placeholder="task.pdf, hints.png" /></div>
                  </div>
                  <div class="field">
                    <label>Учні</label>
                    <select name="students" multiple size="5" required>
                      ${(selectedLesson.studentIds || []).map((id) => db.users[id]).filter(Boolean).map((s) => `<option value="${s.id}" selected>${escapeHtml(s.name)}</option>`).join("")}
                    </select>
                  </div>
                  <button class="btn primary" type="submit">Створити домашку</button>
                </form>
              </div>
              <div style="margin-top:12px;">
                <strong>Домашки по цьому заняттю</strong>
                <div class="list" style="margin-top:8px;">
                  ${linkedAssignments.length ? linkedAssignments.map((a) => `
                    <div class="item">
                      <p class="item-title">${escapeHtml(a.title)}</p>
                      <div class="meta">Дедлайн: ${escapeHtml(formatDate(a.deadline))}</div>
                      <div class="meta">Відповіді: ${Object.keys(a.studentSubmissions || {}).length}</div>
                    </div>
                  `).join("") : '<div class="meta">Ще немає прив’язаних домашніх.</div>'}
                </div>
              </div>
            ` : '<p class="muted">Обери заняття у списку дня.</p>'}
          </div>
        </div>
      </section>
      <section class="panel ${tab === "students" ? "active" : ""}">
        <div class="grid cols-2">
          <div class="card">
            <h3>Нотатка про учня</h3>
            <form id="teacherNotesForm" class="stack">
              <div class="field"><label>Учень</label><select name="studentId" required>${studentOptions}</select></div>
              <div class="field"><label>Нотатка</label><textarea name="note" placeholder="Короткий коментар про прогрес"></textarea></div>
              <button class="btn primary" type="submit">Зберегти нотатку</button>
            </form>
          </div>
          <div class="card">
            <h3>Мої учні</h3>
            <div class="list">
              ${students.map((s) => `
                <div class="item">
                  <p class="item-title">${escapeHtml(s.name)}</p>
                  <div class="meta">${escapeHtml(s.email)}</div>
                  <div class="meta">${escapeHtml(db.personalNotes[s.id] || "Без нотатки")}</div>
                </div>
              `).join("") || '<p class="muted">Немає учнів. Додай їх через адміністратора або в розкладі.</p>'}
            </div>
          </div>
        </div>
      </section>
      <section class="panel ${tab === "assignments" ? "active" : ""}">
        <div class="grid cols-2">
          <div class="card">
            <h3>Додати домашнє завдання</h3>
            <form id="teacherAssignmentForm" class="stack">
              <div class="field"><label>Назва</label><input name="title" required /></div>
              <div class="field"><label>Опис</label><textarea name="description"></textarea></div>
              <div class="grid cols-2">
                <div class="field"><label>Дедлайн</label><input type="date" name="deadline" required /></div>
                <div class="field"><label>Пов'язане заняття</label><select name="linkedLessonId"><option value="">Не вказано</option>${scheduleOptions}</select></div>
              </div>
              <div class="field"><label>Файли від викладача (через кому)</label><input name="teacherFiles" placeholder="task.pdf, hints.png" /></div>
              <div class="field"><label>Учні</label><select name="students" multiple size="6" required>${studentOptions}</select></div>
              <button class="btn primary" type="submit">Додати ДЗ</button>
            </form>
          </div>
          <div class="card">
            <h3>Керування домашніми</h3>
            ${renderTeacherAssignmentManage(teacher.id)}
          </div>
        </div>
      </section>
      <section class="panel ${tab === "materials" ? "active" : ""}">
        <div class="grid cols-2">
          <div class="card">
            <h3>Додати матеріал</h3>
            <form id="teacherMaterialForm" class="stack">
              <div class="field"><label>Учень</label><select name="studentId" required>${studentOptions}</select></div>
              <div class="field"><label>Назва</label><input name="title" required /></div>
              <div class="field"><label>Опис</label><textarea name="description"></textarea></div>
              <div class="grid cols-2">
                <div class="field"><label>Дата</label><input name="date" type="date" required /></div>
                <div class="field"><label>Пов'язане заняття</label><select name="scheduleId"><option value="">Не вказано</option>${scheduleOptions}</select></div>
              </div>
              <div class="field"><label>Файли (через кому)</label><input name="files" placeholder="guide.pdf, sheet.xlsx" /></div>
              <button class="btn primary" type="submit">Додати матеріал</button>
            </form>
          </div>
          <div class="card">
            <h3>Матеріали по учнях</h3>
            <div class="list">
              ${students.map((s) => renderTeacherMaterialGroup(s)).join("") || '<p class="muted">Немає матеріалів.</p>'}
            </div>
          </div>
        </div>
      </section>
    `;
  }

  function renderScheduleItem(s) {
    const studentNames = (s.studentIds || []).map((id) => db.users[id]?.name).filter(Boolean).join(", ");
    return `
      <div class="item">
        <div class="item-head">
          <div>
            <p class="item-title">${escapeHtml(s.subject || "Предмет")} • ${escapeHtml(s.name)}</p>
            <div class="meta">${escapeHtml(formatDateTime(s.date, s.time))} • ${escapeHtml(s.platform)} • ${escapeHtml(statusLabel(s.status))}</div>
            <div class="meta">Учні: ${escapeHtml(studentNames || "немає")}</div>
            ${s.link ? `<div class="meta">Лінк: <a href="${escapeAttr(s.link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(s.link)}</a></div>` : ""}
          </div>
          <div class="row wrap">
            <button type="button" class="btn small secondary" data-action="edit-schedule" data-id="${s.id}">Редагувати</button>
            <button type="button" class="btn small danger" data-action="delete-schedule" data-id="${s.id}">Видалити</button>
          </div>
        </div>
      </div>
    `;
  }

  function renderTeacherAssignmentManage(teacherId) {
    const assignments = db.assignments.filter((a) => a.teacherId === teacherId).sort((a, b) => a.deadline.localeCompare(b.deadline));
    if (!assignments.length) return '<p class="muted">Домашніх завдань ще немає.</p>';
    return assignments.map((a) => {
      const students = a.studentIds.map((id) => db.users[id]).filter(Boolean);
      return `
        <div class="item">
          <div class="item-head">
            <div>
              <p class="item-title">${escapeHtml(a.title)}</p>
              <div class="meta">Дедлайн: ${escapeHtml(formatDate(a.deadline))}</div>
              ${a.description ? `<div class="meta">${escapeHtml(a.description)}</div>` : ""}
            </div>
            <button class="btn small danger" type="button" data-action="delete-assignment" data-id="${a.id}">Видалити</button>
          </div>
          ${a.teacherFiles && a.teacherFiles.length ? `<div class="filebox"><strong>Файли:</strong> ${a.teacherFiles.map(escapeHtml).join(", ")}</div>` : ""}
          <div class="list" style="margin-top:10px;">
            ${students.map((s) => {
              const status = (a.studentStatus && a.studentStatus[s.id]) || "not_started";
              const comment = (a.studentComments && a.studentComments[s.id]) || "";
              const submission = a.studentSubmissions && a.studentSubmissions[s.id];
              return `
                <form id="teacherAssignmentManageForm" class="item">
                  <input type="hidden" name="assignmentId" value="${a.id}" />
                  <input type="hidden" name="studentId" value="${s.id}" />
                  <p class="item-title">${escapeHtml(s.name)}</p>
                  <div class="grid cols-2">
                    <div class="field">
                      <label>Статус</label>
                      <select name="status">
                        <option value="not_started" ${status === "not_started" ? "selected" : ""}>Не почато</option>
                        <option value="in_progress" ${status === "in_progress" ? "selected" : ""}>В процесі</option>
                        <option value="completed" ${status === "completed" ? "selected" : ""}>Завершено</option>
                      </select>
                    </div>
                    <div class="field">
                      <label>Коментар викладача</label>
                      <input name="comment" value="${escapeAttr(comment)}" />
                    </div>
                  </div>
                  ${submission ? `
                    <div class="filebox">
                      <strong>Рішення учня:</strong> ${escapeHtml(submission.date || "")}
                      ${submission.text ? `<div class="meta">${escapeHtml(submission.text)}</div>` : ""}
                      ${submission.files && submission.files.length ? `<div class="meta">Файли: ${submission.files.map(escapeHtml).join(", ")}</div>` : ""}
                    </div>
                  ` : '<div class="meta">Рішення ще не надіслано.</div>'}
                  <button class="btn small secondary" type="submit">Зберегти</button>
                </form>
              `;
            }).join("")}
          </div>
        </div>
      `;
    }).join("");
  }

  function renderTeacherMaterialGroup(student) {
    const materials = (db.studentMaterials[student.id] || []).slice().sort((a, b) => b.date.localeCompare(a.date));
    return `
      <div class="item">
        <p class="item-title">${escapeHtml(student.name)}</p>
        ${materials.length ? materials.map((m) => `
          <div class="item" style="margin-top:8px;">
            <div class="item-head">
              <div>
                <p class="item-title">${escapeHtml(m.title)}</p>
                <div class="meta">${escapeHtml(formatDate(m.date))}</div>
                ${m.description ? `<div class="meta">${escapeHtml(m.description)}</div>` : ""}
                ${m.files && m.files.length ? `<div class="meta">Файли: ${m.files.map(escapeHtml).join(", ")}</div>` : ""}
              </div>
              <button class="btn small danger" type="button" data-action="delete-material" data-id="${m.id}" data-student-id="${student.id}">Видалити</button>
            </div>
          </div>
        `).join("") : '<div class="meta">Ще немає матеріалів.</div>'}
      </div>
    `;
  }

  function renderStudentDashboard(student) {
    const tab = ui.activeTabs.student;
    const mySchedule = db.schedule
      .filter((s) => (s.studentIds || []).includes(student.id))
      .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
    const calendarBase = monthWithOffset(ui.studentCalendarOffset);
    const dayLessons = mySchedule.filter((s) => s.date === ui.studentSelectedDate);
    const myAssignments = db.assignments
      .filter((a) => (a.studentIds || []).includes(student.id) || (a.studentStatus && a.studentStatus[student.id]))
      .sort((a, b) => a.deadline.localeCompare(b.deadline));
    const myMaterials = (db.studentMaterials[student.id] || []).slice().sort((a, b) => b.date.localeCompare(a.date));
    const todayAssignments = myAssignments.filter((a) => a.deadline === currentDateISO(0));
    const overdueAssignments = myAssignments.filter((a) => a.deadline < currentDateISO(0) && ((a.studentStatus && a.studentStatus[student.id]) !== "completed"));
    const upcomingLessons = getLessonsForNextDays(mySchedule, 7);

    return `
      ${renderTabs("student", [
        { id: "schedule", label: "Мій розклад" },
        { id: "assignments", label: "Мої домашні" },
        { id: "materials", label: "Мої матеріали" }
      ])}
      <section class="panel ${tab === "schedule" ? "active" : ""}">
        <div class="grid cols-2 stats-grid">
          <div class="card stat-card"><div class="muted">Уроків сьогодні</div><div class="stat-value">${dayLessons.length}</div></div>
          <div class="card stat-card"><div class="muted">Дедлайн сьогодні</div><div class="stat-value">${todayAssignments.length}</div></div>
          <div class="card stat-card"><div class="muted">Прострочено</div><div class="stat-value">${overdueAssignments.length}</div></div>
          <div class="card stat-card"><div class="muted">Матеріалів</div><div class="stat-value">${myMaterials.length}</div></div>
        </div>
        <div class="card" style="margin-top:10px;">
          <div class="row wrap" style="justify-content: space-between;">
            <strong>Мій навчальний день</strong>
            <button class="btn small secondary" type="button" data-action="student-go-today">Сьогодні</button>
          </div>
          <div class="meta">Показує уроки, статуси та найближчі дедлайни.</div>
        </div>
        <div class="grid cols-2 calendar-layout">
          <div class="card calendar-main">
            <h3>Календар учня</h3>
            ${renderCalendarWidget({
              baseDate: calendarBase,
              selectedDate: ui.studentSelectedDate,
              lessons: mySchedule,
              dayAction: "student-select-date",
              monthAction: "student-shift-month"
            })}
          </div>
          <div class="card calendar-side">
            <h3>Заняття на ${escapeHtml(formatDate(ui.studentSelectedDate))}</h3>
            <div class="list">
              ${dayLessons.map((s) => {
                const teacher = db.users[s.teacherId];
                return `
                  <div class="item">
                    <div class="item-head">
                      <div>
                        <p class="item-title">${escapeHtml(s.time)} • ${escapeHtml(s.subject || "Предмет")}</p>
                        <div class="meta">${escapeHtml(s.name)}</div>
                        <div class="meta">Викладач: ${escapeHtml(teacher ? teacher.name : "Н/Д")} • ${escapeHtml(s.platform)}</div>
                      </div>
                      <span class="pill ${statusPillClass(s.status)}">${escapeHtml(statusLabel(s.status))}</span>
                    </div>
                    ${s.link ? `<div class="meta"><a href="${escapeAttr(s.link)}" target="_blank" rel="noopener noreferrer">Перейти за посиланням</a></div>` : ""}
                  </div>
                `;
              }).join("") || '<p class="muted">На обраний день занять немає.</p>'}
            </div>
          </div>
        </div>
        <div class="card" style="margin-top:14px;">
          <h3>Найближчі 7 днів</h3>
          <div class="list">
            ${upcomingLessons.length ? upcomingLessons.map((lesson) => `
              <div class="item">
                <div class="item-head">
                  <div>
                    <p class="item-title">${escapeHtml(formatDate(lesson.date))} • ${escapeHtml(lesson.time)} • ${escapeHtml(lesson.subject || "Предмет")}</p>
                    <div class="meta">${escapeHtml(lesson.name)}</div>
                  </div>
                  <span class="pill ${statusPillClass(lesson.status)}">${escapeHtml(statusLabel(lesson.status))}</span>
                </div>
              </div>
            `).join("") : '<p class="muted">На найближчі 7 днів занять немає.</p>'}
          </div>
        </div>
      </section>
      <section class="panel ${tab === "assignments" ? "active" : ""}">
        <div class="card">
          <h3>Домашні завдання</h3>
          <div class="list">
            ${myAssignments.map((a) => {
              const status = (a.studentStatus && a.studentStatus[student.id]) || "not_started";
              const comment = (a.studentComments && a.studentComments[student.id]) || "";
              const submission = a.studentSubmissions && a.studentSubmissions[student.id];
              return `
                <div class="item">
                  <div class="item-head">
                    <div>
                      <p class="item-title">${escapeHtml(a.title)}</p>
                      <div class="meta">Дедлайн: ${escapeHtml(formatDate(a.deadline))}</div>
                      ${a.description ? `<div class="meta">${escapeHtml(a.description)}</div>` : ""}
                    </div>
                    ${renderStatus(status)}
                  </div>
                  ${a.teacherFiles && a.teacherFiles.length ? `<div class="filebox"><strong>Файли викладача:</strong> ${a.teacherFiles.map(escapeHtml).join(", ")}</div>` : ""}
                  ${comment ? `<div class="filebox"><strong>Коментар викладача:</strong> ${escapeHtml(comment)}</div>` : ""}
                  ${submission ? `
                    <div class="filebox">
                      <strong>Моє рішення (${escapeHtml(submission.date || "")})</strong>
                      ${submission.text ? `<div class="meta">${escapeHtml(submission.text)}</div>` : ""}
                      ${submission.files && submission.files.length ? `<div class="meta">Файли: ${submission.files.map(escapeHtml).join(", ")}</div>` : ""}
                    </div>
                  ` : ""}
                  <button class="btn small secondary" type="button" data-action="open-submit-modal" data-id="${a.id}">Надіслати / оновити рішення</button>
                </div>
              `;
            }).join("") || '<p class="muted">Домашніх завдань немає.</p>'}
          </div>
        </div>
      </section>
      <section class="panel ${tab === "materials" ? "active" : ""}">
        <div class="card">
          <h3>Матеріали від викладача</h3>
          <div class="list">
            ${myMaterials.map((m) => {
              const lesson = m.scheduleId ? db.schedule.find((s) => s.id === m.scheduleId) : null;
              return `
                <div class="item">
                  <p class="item-title">${escapeHtml(m.title)}</p>
                  <div class="meta">${escapeHtml(formatDate(m.date))}</div>
                  ${lesson ? `<div class="meta">До заняття: ${escapeHtml(lesson.name)} (${escapeHtml(formatDate(lesson.date))})</div>` : ""}
                  ${m.description ? `<div class="meta">${escapeHtml(m.description)}</div>` : ""}
                  ${m.files && m.files.length ? `<div class="filebox"><strong>Файли:</strong> ${m.files.map(escapeHtml).join(", ")}</div>` : ""}
                </div>
              `;
            }).join("") || '<p class="muted">Матеріалів ще немає.</p>'}
          </div>
        </div>
      </section>
    `;
  }

  function renderStudentSubmitModal(user) {
    if (!ui.modalAssignmentId || !user || user.role !== "student") return "";
    const assignment = db.assignments.find((a) => a.id === ui.modalAssignmentId);
    if (!assignment) return "";
    const existing = assignment.studentSubmissions && assignment.studentSubmissions[user.id];

    return `
      <div class="modal open" role="dialog" aria-modal="true">
        <div class="modal-card">
          <div class="modal-head">
            <h3 style="margin:0;">Надіслати рішення: ${escapeHtml(assignment.title)}</h3>
            <button class="btn small secondary" type="button" data-action="close-submit-modal">Закрити</button>
          </div>
          <form id="studentSubmitForm" class="stack">
            <div class="field">
              <label>Текст рішення</label>
              <textarea name="solutionText" placeholder="Опиши, як ти виконав(ла) завдання...">${existing ? escapeHtml(existing.text || "") : ""}</textarea>
            </div>
            <div class="field">
              <label>Файли (назви через кому)</label>
              <input name="solutionFiles" placeholder="photo1.jpg, answer.pdf" value="${existing && existing.files ? escapeAttr(existing.files.join(", ")) : ""}" />
            </div>
            <div class="row wrap">
              <button class="btn primary" type="submit">Надіслати</button>
              <button class="btn secondary" type="button" data-action="close-submit-modal">Скасувати</button>
            </div>
          </form>
        </div>
      </div>
    `;
  }

  function renderCloudStatus() {
    if (!isCloudConfigured()) return '<span class="status-warn">не налаштовано</span>';
    if (!window.supabase || typeof window.supabase.createClient !== "function") return '<span class="status-warn">SDK не завантажено</span>';
    return '<span class="status-ok">готово до синхронізації</span>';
  }

  function queueCloudPush() {
    if (cloudSyncTimer) {
      clearTimeout(cloudSyncTimer);
    }
    cloudSyncTimer = setTimeout(() => {
      cloudSyncTimer = null;
      void cloudPush(true);
    }, 900);
  }

  async function cloudPush(silent) {
    const client = getSupabaseClient();
    if (!client) {
      if (!silent) {
        ui.message = { type: "error", text: "Cloud не налаштовано або SDK Supabase не завантажився." };
        renderApp();
      }
      return;
    }
    try {
      const payload = JSON.parse(JSON.stringify(db));
      const row = {
        portal_id: cloud.portalId,
        payload,
        updated_at: new Date().toISOString()
      };
      const { error } = await client.from(CLOUD_TABLE).upsert(row, { onConflict: "portal_id" });
      if (error) throw error;
      if (!silent) {
        ui.message = { type: "success", text: "Дані успішно синхронізовано в Supabase." };
        renderApp();
      }
    } catch (err) {
      if (!silent) {
        ui.message = { type: "error", text: `Помилка push у Cloud: ${String(err.message || err)}` };
        renderApp();
      }
    }
  }

  async function cloudPull() {
    const client = getSupabaseClient();
    if (!client) {
      ui.message = { type: "error", text: "Cloud не налаштовано або SDK Supabase не завантажився." };
      renderApp();
      return;
    }
    try {
      const { data, error } = await client
        .from(CLOUD_TABLE)
        .select("payload")
        .eq("portal_id", cloud.portalId)
        .maybeSingle();
      if (error) throw error;
      if (!data || !data.payload) {
        ui.message = { type: "error", text: "У Supabase ще немає збереженого стану для цього Portal ID." };
        renderApp();
        return;
      }
      const merged = mergeWithDefaults(data.payload);
      overwriteObject(db, merged);
      normalizeRelationsAfterRoleChanges();
      saveDb();
      ui.message = { type: "success", text: "Дані завантажено з Supabase." };
      renderApp();
    } catch (err) {
      ui.message = { type: "error", text: `Помилка pull із Cloud: ${String(err.message || err)}` };
      renderApp();
    }
  }

  function renderMessage() {
    if (!ui.message) return "";
    const cls = ui.message.type === "error" ? "error" : "success";
    return `<div class="msg ${cls}" style="margin: 0 0 12px;">${escapeHtml(ui.message.text)}</div>`;
  }

  function renderTabs(role, items) {
    const active = ui.activeTabs[role];
    return `
      <nav class="tabs">
        ${items.map((t) => `<button type="button" class="tab-btn ${active === t.id ? "active" : ""}" data-action="set-tab" data-role="${role}" data-tab="${t.id}">${escapeHtml(t.label)}</button>`).join("")}
      </nav>
    `;
  }

  function readValue(form, name) {
    return (form.querySelector(`[name="${name}"]`)?.value || "").trim();
  }

  function readMulti(form, name) {
    const el = form.querySelector(`[name="${name}"]`);
    if (!el) return [];
    const opts = Array.from(el.selectedOptions || []);
    return opts.map((o) => o.value).filter(Boolean);
  }

  function getUsersByRole(role) {
    return Object.values(db.users).filter((u) => u.role === role).sort((a, b) => a.name.localeCompare(b.name, "uk"));
  }

  function getTeacherStudents(teacherId) {
    const teacher = db.users[teacherId];
    const fromProfile = (teacher && Array.isArray(teacher.students)) ? teacher.students : [];
    const fromSchedule = db.schedule
      .filter((s) => s.teacherId === teacherId)
      .flatMap((s) => s.studentIds || []);
    const ids = unique([...fromProfile, ...fromSchedule]);
    return ids.map((id) => db.users[id]).filter((u) => u && u.role === "student");
  }

  function unique(arr) {
    return Array.from(new Set(arr));
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  function currentDateISO(offsetDays) {
    const d = new Date();
    d.setDate(d.getDate() + offsetDays);
    return d.toISOString().slice(0, 10);
  }

  function formatDate(dateStr) {
    if (!dateStr) return "";
    const d = new Date(dateStr + "T00:00:00");
    return d.toLocaleDateString("uk-UA");
  }

  function formatDateTime(dateStr, timeStr) {
    return `${formatDate(dateStr)} ${timeStr || ""}`.trim();
  }

  function monthWithOffset(offset) {
    const d = new Date();
    d.setDate(1);
    d.setMonth(d.getMonth() + offset);
    return d;
  }

  function renderCalendarWidget({ baseDate, selectedDate, lessons, dayAction, monthAction }) {
    const year = baseDate.getFullYear();
    const month = baseDate.getMonth();
    const monthStart = new Date(year, month, 1);
    const monthLabel = monthStart.toLocaleDateString("uk-UA", { month: "long", year: "numeric" });
    const firstWeekday = (monthStart.getDay() + 6) % 7;
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const totalCells = Math.ceil((firstWeekday + daysInMonth) / 7) * 7;
    const lessonMap = new Map();
    lessons.forEach((l) => {
      const key = l.date;
      if (!lessonMap.has(key)) lessonMap.set(key, []);
      lessonMap.get(key).push(l);
    });

    let cells = "";
    for (let i = 0; i < totalCells; i += 1) {
      const dayNumber = i - firstWeekday + 1;
      if (dayNumber < 1 || dayNumber > daysInMonth) {
        cells += '<div class="calendar-day empty"></div>';
      } else {
        const dateIso = isoDateFromParts(year, month + 1, dayNumber);
        const entries = lessonMap.get(dateIso) || [];
        const isSelected = selectedDate === dateIso;
        const isToday = dateIso === currentDateISO(0);
        const badge = entries.length ? `<span class="calendar-count">${entries.length}</span>` : "";
        cells += `
          <button type="button" class="calendar-day ${isSelected ? "selected" : ""} ${isToday ? "today" : ""}" data-action="${dayAction}" data-date="${dateIso}">
            <span>${dayNumber}</span>
            ${badge}
          </button>
        `;
      }
    }

    return `
      <div class="calendar-wrap">
        <div class="calendar-toolbar">
          <button type="button" class="btn secondary small" data-action="${monthAction}" data-delta="-1">←</button>
          <strong>${escapeHtml(monthLabel)}</strong>
          <button type="button" class="btn secondary small" data-action="${monthAction}" data-delta="1">→</button>
        </div>
        <div class="calendar-grid labels">
          <span>Пн</span><span>Вт</span><span>Ср</span><span>Чт</span><span>Пт</span><span>Сб</span><span>Нд</span>
        </div>
        <div class="calendar-grid days">${cells}</div>
      </div>
    `;
  }

  function isoDateFromParts(y, m, d) {
    return `${String(y)}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }

  function getFreeTimeSlots(dayLessons) {
    const all = [];
    for (let hour = 8; hour <= 20; hour += 1) {
      all.push(`${String(hour).padStart(2, "0")}:00`);
    }
    const busy = new Set(dayLessons.map((x) => x.time));
    return all.filter((slot) => !busy.has(slot));
  }

  function getLessonsForNextDays(lessons, days) {
    const start = currentDateISO(0);
    const endDate = new Date();
    endDate.setDate(endDate.getDate() + (days - 1));
    const end = endDate.toISOString().slice(0, 10);
    return lessons.filter((l) => l.date >= start && l.date <= end)
      .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  }

  function statusLabel(status) {
    if (status === "done") return "Проведено";
    if (status === "cancelled") return "Скасовано";
    return "Заплановано";
  }

  function statusPillClass(status) {
    if (status === "done") return "done";
    if (status === "cancelled") return "cancelled";
    return "progress";
  }

  function renderStatus(status) {
    if (status === "completed") return '<span class="pill done">Завершено</span>';
    if (status === "in_progress") return '<span class="pill progress">В процесі</span>';
    return '<span class="pill pending">Не почато</span>';
  }

  function overwriteObject(target, source) {
    Object.keys(target).forEach((k) => delete target[k]);
    Object.keys(source).forEach((k) => {
      target[k] = source[k];
    });
  }

  function exportData() {
    const data = JSON.stringify(db, null, 2);
    const blob = new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `teacher-portal-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function importDataFromInput(input) {
    const file = input.files && input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result || ""));
        const merged = mergeWithDefaults(parsed);
        overwriteObject(db, merged);
        normalizeRelationsAfterRoleChanges();
        saveDb();
        ui.message = { type: "success", text: "Дані успішно імпортовано." };
      } catch (err) {
        ui.message = { type: "error", text: "Не вдалося імпортувати файл: невірний JSON." };
      }
      input.value = "";
      renderApp();
    };
    reader.readAsText(file, "utf-8");
  }

  function escapeHtml(value) {
    return String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function escapeAttr(value) {
    return escapeHtml(value).replaceAll("`", "&#96;");
  }
})();
